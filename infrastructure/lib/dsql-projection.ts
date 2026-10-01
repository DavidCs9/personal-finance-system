import { ArnFormat, Aws, CfnOutput, CfnResource, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { StepFunctionsStartExecution } from 'aws-cdk-lib/aws-scheduler-targets';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'node:path';

export class DsqlProjection extends Construct {
  constructor(scope: Construct, id: string, props: {
    table: dynamodb.ITable; encryptionKey: kms.IKey; alertRecipientEmail: string;
  }) {
    super(scope, id);
    const cluster = new dsql.CfnCluster(this, 'Cluster', { deletionProtectionEnabled: true });
    cluster.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const recovery = new s3.Bucket(this, 'Recovery', {
      encryption: s3.BucketEncryption.KMS, encryptionKey: props.encryptionKey,
      enforceSSL: true, versioned: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Change only through a reviewed PR/deploy-production rollout. A code flag
    // avoids CloudFormation silently reusing an old parameter during rollback.
    const captureEnabled = true;
    const createFunction = (name: string, entry: string, timeout: number): NodejsFunction => new NodejsFunction(this, name, {
      functionName: `personal-finance-v1-dsql-${entry}`, runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '..', 'lambda', `dsql-${entry}.ts`), handler: 'handler',
      timeout: Duration.seconds(timeout), memorySize: 512,
      logGroup: new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/personal-finance-v1-dsql-${entry}`,
        retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN,
      }),
      bundling: { minify: true, sourceMap: true, target: 'node24', externalModules: [], },
      environment: { DSQL_ENDPOINT: cluster.attrEndpoint, METADATA_TABLE_NAME: props.table.tableName, DSQL_RECOVERY_BUCKET: recovery.bucketName },
    });
    const projector = createFunction('Projector', 'projector', 120);
    const maintenance = createFunction('Maintenance', 'maintenance', 600);
    const replay = createFunction('Replay', 'replay', 600);
    const schema = createFunction('Schema', 'schema', 600);
    const runtimes = [projector, maintenance, replay, schema];
    for (const fn of runtimes) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [cluster.attrResourceArn] }));
    }
    for (const fn of [projector, maintenance, replay]) {
      props.table.grant(fn, 'dynamodb:GetItem');
      props.encryptionKey.grantDecrypt(fn);
    }
    props.table.grant(maintenance, 'dynamodb:Scan');
    schema.addToRolePolicy(new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [cluster.attrResourceArn] }));
    recovery.grantRead(replay, 'aws/lambda/*');
    recovery.grantPut(maintenance, 'reconciliation/*');
    const provider = new cr.Provider(this, 'SchemaProvider', {
      onEventHandler: schema,
      logGroup: new logs.LogGroup(this, 'SchemaProviderLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN }),
    });
    const bootstrap = new CustomResource(this, 'Bootstrap', {
      serviceToken: provider.serviceToken,
      properties: { Version: 2, RuntimeRoleArns: runtimes.map((fn) => fn.role!.roleArn) },
    });
    // IAM policies must be installed before the bootstrap handler connects.
    for (const fn of runtimes) bootstrap.node.addDependency(fn.role!);
    projector.addEventSource(new DynamoEventSource(props.table, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 25, parallelizationFactor: 1, retryAttempts: 10,
      maxRecordAge: Duration.hours(6), bisectBatchOnError: true,
      reportBatchItemFailures: true,
      // CDK's S3OnFailureDestination also grants DeleteObject. The native mapping
      // only needs ListBucket and PutObject. Its destination validation requires
      // bucket-wide object scope, even though delivery uses aws/lambda/ keys.
      onFailure: { bind: (_mapping, fn) => {
        fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [recovery.bucketArn] }));
        fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [recovery.arnForObjects('*')], conditions: { StringEquals: { 's3:ResourceAccount': Aws.ACCOUNT_ID } } }));
        props.encryptionKey.grantEncryptDecrypt(fn);
        return { destination: recovery.bucketArn };
      } },
      metricsConfig: { metrics: [lambda.MetricType.EVENT_COUNT] },
    }));
    const mapping = projector.node.findAll().find((node): node is lambda.CfnEventSourceMapping => node instanceof lambda.CfnEventSourceMapping)!;
    mapping.enabled = captureEnabled;
    mapping.addResourceDependency(bootstrap.node.defaultChild as CfnResource);

    const invoke = new tasks.LambdaInvoke(this, 'ReconcilePage', {
      lambdaFunction: maintenance, payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({ 'phase.$': '$.phase', 'cursor.$': '$.cursor',
        'projected.$': '$.projected', 'equal.$': '$.equal', 'lag.$': '$.lag', 'mismatch.$': '$.mismatch', 'sourceTotals.$': '$.sourceTotals', 'runId.$': '$$.Execution.Id' }),
    });
    // Page retries are idempotent, including an invocation whose response was lost.
    invoke.addRetry({ errors: ['States.TaskFailed'], interval: Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });
    const initialize = new sfn.Pass(this, 'Initialize', {
      result: sfn.Result.fromObject({ phase: 'source', cursor: null, projected: 0, equal: 0, lag: 0, mismatch: 0, sourceTotals: {} }),
    });
    const completed = new sfn.Choice(this, 'Completed');
    const parity = new sfn.Choice(this, 'Parity');
    const success = new sfn.Succeed(this, 'Verified');
    const failure = new sfn.Fail(this, 'ParityFailed', { error: 'DsqlParityFailed', cause: 'Reconciliation found lag or mismatched relational rows; inspect the retained progress report and rerun.' });
    parity.when(sfn.Condition.and(sfn.Condition.numberEquals('$.lag', 0), sfn.Condition.numberEquals('$.mismatch', 0)), success).otherwise(failure);
    completed.when(sfn.Condition.stringEquals('$.phase', 'done'), parity).otherwise(invoke);
    invoke.next(completed);
    const machine = new sfn.StateMachine(this, 'Reconciliation', {
      stateMachineName: 'personal-finance-v1-dsql-reconciliation',
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Choice(this, 'ResumeOrInitialize')
        .when(sfn.Condition.isPresent('$.phase'), invoke).otherwise(initialize.next(invoke))),
      timeout: Duration.hours(4),
      logs: { destination: new logs.LogGroup(this, 'ReconciliationLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN }), level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    machine.node.addDependency(bootstrap);
    new scheduler.Schedule(this, 'DailyReconciliation', {
      scheduleName: 'personal-finance-v1-dsql-reconciliation',
      schedule: scheduler.ScheduleExpression.rate(Duration.days(1)),
      target: new StepFunctionsStartExecution(machine, { input: scheduler.ScheduleTargetInput.fromObject({}) }),
    });
    const alerts = new sns.Topic(this, 'Alerts', { masterKey: props.encryptionKey });
    alerts.addSubscription(new subscriptions.EmailSubscription(props.alertRecipientEmail));
    alerts.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'], resources: [alerts.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': Stack.of(this).formatArn({ service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME }) } },
    }));
    // Allow CloudWatch to publish to the encrypted operational topic.
    props.encryptionKey.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')], actions: ['kms:GenerateDataKey*', 'kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold = 1): void => {
      const resource = new cloudwatch.Alarm(this, id, { metric, threshold, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
      resource.addAlarmAction(new actions.SnsAction(alerts));
    };
    alarm('ProjectionErrors', projector.metricErrors({ period: Duration.minutes(5) }));
    alarm('ProjectionThrottles', projector.metricThrottles({ period: Duration.minutes(5) }));
    alarm('ProjectionLag', projector.metric('IteratorAge', { statistic: 'Maximum', period: Duration.minutes(5) }), 300_000);
    alarm('FailedStreamRecords', new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'FailedInvokeEventCount', dimensionsMap: { FunctionName: projector.functionName, EventSourceMappingUUID: mapping.ref }, statistic: 'Sum', period: Duration.minutes(5) }));
    alarm('RecoveryObjects', new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'OnFailureDestinationDeliveredEventCount', dimensionsMap: { FunctionName: projector.functionName, EventSourceMappingUUID: mapping.ref }, statistic: 'Sum', period: Duration.minutes(5) }));
    alarm('RecoveryDeliveryFailures', projector.metric('DestinationDeliveryFailures', { statistic: 'Sum', period: Duration.minutes(5) }));
    alarm('ReconciliationFailures', machine.metricFailed({ period: Duration.minutes(5) }));
    alarm('ReconciliationTimeouts', machine.metricTimedOut({ period: Duration.minutes(5) }));

    // Add narrow post-deploy verification permissions to the existing Actions role.
    // This policy is part of PersonalFinanceV1, so no bootstrap-stack rollout is needed.
    const deployRole = iam.Role.fromRoleName(this, 'DeployRole', 'personal-finance-v1-github-deploy');
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [machine.stateMachineArn] }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [Stack.of(this).formatArn({ service: 'states', resource: 'execution', resourceName: 'personal-finance-v1-dsql-reconciliation:*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));
    deployRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [Stack.of(this).stackId] }));
    new CfnOutput(Stack.of(this), 'DsqlEndpoint', { value: cluster.attrEndpoint });
    new CfnOutput(Stack.of(this), 'DsqlRecoveryBucket', { value: recovery.bucketName });
    new CfnOutput(Stack.of(this), 'DsqlReconciliationArn', { value: machine.stateMachineArn });
    new CfnOutput(Stack.of(this), 'DsqlReplayFunction', { value: replay.functionName });
    new CfnOutput(Stack.of(this), 'DsqlEventSourceMapping', { value: mapping.ref });
    new CfnOutput(Stack.of(this), 'DsqlAlertsTopic', { value: alerts.topicArn });
  }
}

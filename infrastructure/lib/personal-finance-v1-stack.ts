import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'node:path';

export class PersonalFinanceV1Stack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tags = {
      Project: 'personal-finance-system',
      Environment: 'prod',
      ManagedBy: 'cdk',
    };
    Object.entries(tags).forEach(([key, value]) => cdk.Tags.of(this).add(key, value));

    const senderEmail = new cdk.CfnParameter(this, 'SesSenderEmail', {
      type: 'String',
      default: 'replace-with-verified-sender@example.com',
      description: 'Verified SES sender address. Update before enabling notifications.',
    });
    const alertRecipientEmail = new cdk.CfnParameter(this, 'AlertRecipientEmail', {
      type: 'String',
      default: 'replace-with-alert-recipient@example.com',
      description: 'Primary address that receives V1 event alerts.',
    });
    const discoveryScheduleExpression = new cdk.CfnParameter(this, 'DiscoveryScheduleExpression', {
      type: 'String',
      default: 'rate(5 minutes)',
      description: 'EventBridge Scheduler expression. Update this stack parameter to change polling frequency.',
    });

    const encryptionKey = new kms.Key(this, 'DataEncryptionKey', {
      alias: 'alias/personal-finance-system-data',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Encrypts personal-finance raw email sources and DynamoDB metadata.',
    });

    const rawEmailBucket = new s3.Bucket(this, 'RawEmailBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const metadataTable = new dynamodb.Table(this, 'MetadataTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: 35,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    metadataTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    metadataTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const deadLetterQueue = new sqs.Queue(this, 'IngestionDeadLetterQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const ingestionQueue = new sqs.Queue(this, 'IngestionQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const gmailOAuthSecret = new secretsmanager.Secret(this, 'GmailOAuthSecret', {
      secretName: 'personal-finance-system/gmail-oauth',
      description: 'Store Gmail OAuth refresh-token configuration here after Google setup.',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const dataStorageEnvironment = {
      METADATA_TABLE_NAME: metadataTable.tableName,
      RAW_EMAIL_BUCKET_NAME: rawEmailBucket.bucketName,
    };
    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    };

    const discoveryFunction = new NodejsFunction(this, 'DiscoveryFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-discovery',
      logGroup: this.createLogGroup('DiscoveryLogGroup', 'personal-finance-v1-discovery'),
      entry: path.join(__dirname, '..', 'lambda', 'discovery.ts'),
      handler: 'handler',
      description: 'Discovers new Gmail messages and enqueues work for ingestion.',
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        GMAIL_OAUTH_SECRET_ARN: gmailOAuthSecret.secretArn,
      },
    });
    gmailOAuthSecret.grantRead(discoveryFunction);
    ingestionQueue.grantSendMessages(discoveryFunction);
    metadataTable.grantReadWriteData(discoveryFunction);

    const ingestionFunction = new NodejsFunction(this, 'IngestionFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-ingestion',
      logGroup: this.createLogGroup('IngestionLogGroup', 'personal-finance-v1-ingestion'),
      entry: path.join(__dirname, '..', 'lambda', 'ingestion.ts'),
      handler: 'handler',
      description: 'Persists raw email, performs deduplication, and creates observed events.',
      environment: {
        ...dataStorageEnvironment,
        GMAIL_OAUTH_SECRET_ARN: gmailOAuthSecret.secretArn,
        ALERT_SENDER_EMAIL: senderEmail.valueAsString,
        ALERT_RECIPIENT_EMAIL: alertRecipientEmail.valueAsString,
      },
    });
    rawEmailBucket.grantRead(ingestionFunction);
    rawEmailBucket.grantPut(ingestionFunction);
    metadataTable.grantReadWriteData(ingestionFunction);
    gmailOAuthSecret.grantRead(ingestionFunction);
    ingestionFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
      conditions: { StringEquals: { 'ses:FromAddress': senderEmail.valueAsString } },
    }));
    ingestionFunction.addEventSourceMapping('IngestionQueueMapping', {
      eventSourceArn: ingestionQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });
    ingestionQueue.grantConsumeMessages(ingestionFunction);

    const schedulerRole = new iam.Role(this, 'DiscoverySchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke the Gmail discovery Lambda.',
    });
    discoveryFunction.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, 'DiscoverySchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: discoveryScheduleExpression.valueAsString,
      state: 'ENABLED',
      target: {
        arn: discoveryFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumEventAgeInSeconds: 300, maximumRetryAttempts: 2 },
      },
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      generateSecret: false,
    });

    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-api',
      logGroup: this.createLogGroup('ApiLogGroup', 'personal-finance-v1-api'),
      entry: path.join(__dirname, '..', 'lambda', 'api.ts'),
      handler: 'handler',
      description: 'Authenticated API placeholder for the personal-finance UI.',
      environment: dataStorageEnvironment,
    });
    rawEmailBucket.grantRead(apiFunction);
    metadataTable.grantReadData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [metadataTable.tableArn, `${metadataTable.tableArn}/index/*`],
    }));

    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'personal-finance-v1',
      description: 'Authenticated personal-finance API.',
      createDefaultStage: true,
    });
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwtAuthorizer',
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const apiIntegration = new HttpLambdaIntegration('ApiLambdaIntegration', apiFunction);
    for (const route of ['GET /events', 'GET /events/{eventId}', 'GET /events/{eventId}/raw', 'PATCH /events/{eventId}']) {
      httpApi.addRoutes({
        path: route.split(' ')[1],
        methods: [route.split(' ')[0] as apigatewayv2.HttpMethod],
        integration: apiIntegration,
        authorizer,
      });
    }

    const webBucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'apps', 'web', 'dist'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    const discoveryErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'DiscoveryErrorsAlarm', {
      metric: discoveryFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
    });
    const ingestionErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'IngestionErrorsAlarm', {
      metric: ingestionFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
    });
    const deadLetterAlarm = new cdk.aws_cloudwatch.Alarm(this, 'DeadLetterMessagesAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    new cdk.CfnOutput(this, 'RawEmailBucketName', { value: rawEmailBucket.bucketName });
    new cdk.CfnOutput(this, 'MetadataTableName', { value: metadataTable.tableName });
    new cdk.CfnOutput(this, 'IngestionQueueUrl', { value: ingestionQueue.queueUrl });
    new cdk.CfnOutput(this, 'GmailOAuthSecretArn', { value: gmailOAuthSecret.secretArn });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'WebDistributionUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'ConfiguredScheduleExpression', { value: discoveryScheduleExpression.valueAsString });
    new cdk.CfnOutput(this, 'DiscoveryErrorsAlarmName', { value: discoveryErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'IngestionErrorsAlarmName', { value: ingestionErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'DeadLetterMessagesAlarmName', { value: deadLetterAlarm.alarmName });
  }

  private createLogGroup(id: string, functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

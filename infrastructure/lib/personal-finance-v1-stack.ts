import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
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
    const webDomainName = 'finance.castrodavid.dev';
    const inboundDomainName = 'inbound.finance.castrodavid.dev';
    const inboundRecipientEmail = `alertas@${inboundDomainName}`;
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'CastroDavidDevZone', {
      hostedZoneId: 'Z09057602V6K42SQPOMLC',
      zoneName: 'castrodavid.dev',
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

    const ingestionFunction = new NodejsFunction(this, 'IngestionFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-ingestion',
      logGroup: this.createLogGroup('IngestionLogGroup', 'personal-finance-v1-ingestion'),
      entry: path.join(__dirname, '..', 'lambda', 'ingestion.ts'),
      handler: 'handler',
      description: 'Processes SES-received email, deduplicates it, and creates observed events.',
      environment: {
        ...dataStorageEnvironment,
        ALERT_SENDER_EMAIL: senderEmail.valueAsString,
        ALERT_RECIPIENT_EMAIL: alertRecipientEmail.valueAsString,
      },
    });
    rawEmailBucket.grantRead(ingestionFunction);
    metadataTable.grantReadWriteData(ingestionFunction);
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

    const emailReceiptFunction = new NodejsFunction(this, 'EmailReceiptFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-email-receipt',
      logGroup: this.createLogGroup('EmailReceiptLogGroup', 'personal-finance-v1-email-receipt'),
      entry: path.join(__dirname, '..', 'lambda', 'receipt.ts'),
      handler: 'handler',
      description: 'Receives SES mail metadata after raw MIME has been written to S3.',
      environment: {
        RAW_EMAIL_BUCKET_NAME: rawEmailBucket.bucketName,
        RAW_EMAIL_PREFIX: 'inbound/',
        INGESTION_QUEUE_URL: ingestionQueue.queueUrl,
      },
    });
    ingestionQueue.grantSendMessages(emailReceiptFunction);

    const emailIdentity = new ses.EmailIdentity(this, 'InboundEmailIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
    });
    const emailReceiptRole = new iam.Role(this, 'SesEmailReceiptRole', {
      assumedBy: new iam.ServicePrincipal('ses.amazonaws.com'),
      description: 'Lets SES store received raw email using the bucket default KMS encryption.',
    });
    rawEmailBucket.grantPut(emailReceiptRole);
    encryptionKey.grantEncrypt(emailReceiptRole);
    const inboundMxRecord = new route53.MxRecord(this, 'InboundEmailMxRecord', {
      zone: hostedZone,
      recordName: 'inbound.finance',
      values: [{ priority: 10, hostName: 'inbound-smtp.us-east-2.amazonaws.com' }],
    });
    const receiptRuleSetName = 'personal-finance-v1-inbound';
    const receiptRuleSet = new ses.CfnReceiptRuleSet(this, 'InboundReceiptRuleSet', {
      ruleSetName: receiptRuleSetName,
    });
    const receiptRule = new ses.CfnReceiptRule(this, 'InboundReceiptRule', {
      ruleSetName: receiptRuleSetName,
      rule: {
        name: 'store-and-queue-finance-alerts',
        enabled: true,
        scanEnabled: true,
        recipients: [inboundRecipientEmail],
        actions: [
          {
            s3Action: {
              bucketName: rawEmailBucket.bucketName,
              iamRoleArn: emailReceiptRole.roleArn,
              objectKeyPrefix: 'inbound/',
            },
          },
          {
            lambdaAction: {
              functionArn: emailReceiptFunction.functionArn,
              invocationType: 'Event',
            },
          },
        ],
      },
    });
    receiptRule.addResourceDependency(receiptRuleSet);
    receiptRule.addResourceDependency(emailIdentity.node.defaultChild as cdk.CfnResource);
    emailReceiptFunction.addPermission('AllowSesReceiptRuleInvocation', {
      principal: new iam.ServicePrincipal('ses.amazonaws.com'),
      sourceAccount: this.account,
    });
    const activeReceiptRuleSet = new cr.AwsCustomResource(this, 'ActivateInboundReceiptRuleSet', {
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of(receiptRuleSetName),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of(receiptRuleSetName),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
    });
    activeReceiptRuleSet.node.addDependency(receiptRule);
    activeReceiptRuleSet.node.addDependency(inboundMxRecord);

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
    const webCertificate = new acm.DnsValidatedCertificate(this, 'WebCertificate', {
      domainName: webDomainName,
      hostedZone,
      region: 'us-east-1',
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      domainNames: [webDomainName],
      certificate: webCertificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
    new route53.ARecord(this, 'WebAliasRecord', {
      zone: hostedZone,
      recordName: webDomainName,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'WebAliasIpv6Record', {
      zone: hostedZone,
      recordName: webDomainName,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });
    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'apps', 'web', 'dist'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    const receiptErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'EmailReceiptErrorsAlarm', {
      metric: emailReceiptFunction.metricErrors({ period: Duration.minutes(5) }),
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
    new cdk.CfnOutput(this, 'InboundEmailAddress', { value: inboundRecipientEmail });
    new cdk.CfnOutput(this, 'InboundEmailDomain', { value: inboundDomainName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'WebDistributionUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'WebCustomDomainUrl', { value: `https://${webDomainName}` });
    new cdk.CfnOutput(this, 'EmailReceiptErrorsAlarmName', { value: receiptErrorAlarm.alarmName });
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

import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import type { IConstruct } from 'constructs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import {
  OLBIA_SYSTEM_PROMPT,
  OLBIA_SYSTEM_PROMPT_INFERENCE,
  OLBIA_SYSTEM_PROMPT_MODEL_ID,
  OLBIA_SYSTEM_PROMPT_NAME,
  OLBIA_SYSTEM_PROMPT_VARIANT,
} from '@finance/api/agent-prompts';

export class PersonalFinanceV1Stack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    cdk.Aspects.of(this).add({
      visit: (node: IConstruct): void => {
        if (node instanceof lambda.CfnFunction && node.reservedConcurrentExecutions !== undefined) {
          throw new Error(`Reserved Lambda concurrency is not allowed in this project: ${node.node.path}`);
        }
      },
    });

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
    const agentOwnerSub = new cdk.CfnParameter(this, 'AgentOwnerSub', {
      type: 'String',
      default: '',
      description: 'Cognito sub of the single finance owner used by AgentCore Gateway tools.',
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
      stream: dynamodb.StreamViewType.NEW_IMAGE,
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
    metadataTable.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
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
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: { minify: true, sourceMap: true, target: 'node24' },
    };
    const pushLambdaDefaults = {
      ...lambdaDefaults,
      bundling: {
        ...lambdaDefaults.bundling,
        nodeModules: ['web-push'],
      },
    };

    const webAppUrl = `https://${webDomainName}`;
    const vapidSecret = new secretsmanager.Secret(this, 'WebPushVapidSecret', {
      description: 'VAPID key pair used to authenticate Olbia Web Push notifications.',
      secretObjectValue: {
        publicKey: cdk.SecretValue.unsafePlainText('pending'),
        privateKey: cdk.SecretValue.unsafePlainText('pending'),
        subject: cdk.SecretValue.unsafePlainText('mailto:alerts@finance.castrodavid.dev'),
      },
    });
    const vapidKeysFunction = new NodejsFunction(this, 'VapidKeysFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-vapid-keys',
      logGroup: this.createLogGroup('VapidKeysLogGroup', 'personal-finance-v1-vapid-keys'),
      entry: path.join(__dirname, '..', 'lambda', 'vapid-keys.ts'),
      handler: 'handler',
      description: 'Generates durable VAPID keys for Web Push once per environment.',
      timeout: Duration.minutes(2),
    });
    vapidSecret.grantRead(vapidKeysFunction);
    vapidSecret.grantWrite(vapidKeysFunction);
    const vapidKeysProvider = new cr.Provider(this, 'VapidKeysProvider', {
      onEventHandler: vapidKeysFunction,
      logGroup: this.createLogGroup('VapidKeysProviderLogGroup', 'personal-finance-v1-vapid-keys-provider'),
    });
    const vapidKeys = new cdk.CustomResource(this, 'WebPushVapidKeys', {
      serviceToken: vapidKeysProvider.serviceToken,
      properties: {
        SecretArn: vapidSecret.secretArn,
        Subject: 'mailto:alerts@finance.castrodavid.dev',
      },
    });
    const vapidPublicKey = vapidKeys.getAttString('PublicKey');

    const ingestionFunction = new NodejsFunction(this, 'IngestionFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-ingestion',
      logGroup: this.createLogGroup('IngestionLogGroup', 'personal-finance-v1-ingestion'),
      entry: path.join(__dirname, '..', 'lambda', 'ingestion.ts'),
      handler: 'handler',
      description: 'Processes SES-received email, deduplicates it, and creates observed events.',
      environment: {
        ...dataStorageEnvironment,
        ALERT_SENDER_EMAIL: senderEmail.valueAsString,
        ALERT_RECIPIENT_EMAIL: alertRecipientEmail.valueAsString,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    rawEmailBucket.grantRead(ingestionFunction);
    metadataTable.grantReadWriteData(ingestionFunction);
    vapidSecret.grantRead(ingestionFunction);
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

    const retryDispatcherFunction = new NodejsFunction(this, 'RetryDispatcherFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-retry-dispatcher',
      logGroup: this.createLogGroup('RetryDispatcherLogGroup', 'personal-finance-v1-retry-dispatcher'),
      entry: path.join(__dirname, '..', 'lambda', 'retry-dispatcher.ts'), handler: 'handler',
      environment: { ...dataStorageEnvironment, INGESTION_QUEUE_URL: ingestionQueue.queueUrl },
    });
    metadataTable.grantReadWriteData(retryDispatcherFunction);
    ingestionQueue.grantSendMessages(retryDispatcherFunction);
    retryDispatcherFunction.addEventSource(new DynamoEventSource(metadataTable, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 1, retryAttempts: 3 }));

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
      authFlows: { userSrp: true, userPassword: true },
      preventUserExistenceErrors: true,
      generateSecret: false,
      refreshTokenValidity: Duration.days(365),
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
    rawEmailBucket.grantPut(apiFunction);
    metadataTable.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [metadataTable.tableArn, `${metadataTable.tableArn}/index/*`],
    }));
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['textract:StartDocumentAnalysis', 'textract:GetDocumentAnalysis'],
      resources: ['*'],
    }));

    const agentToolsFunction = new NodejsFunction(this, 'AgentToolsFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-agent-tools',
      logGroup: this.createLogGroup('AgentToolsLogGroup', 'personal-finance-v1-agent-tools'),
      entry: path.join(__dirname, '..', 'lambda', 'agent-tools.ts'),
      handler: 'handler',
      description: 'AgentCore Gateway Lambda target — Olbia finance aggregation tools.',
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...dataStorageEnvironment,
        AGENT_OWNER: agentOwnerSub.valueAsString,
      },
    });
    metadataTable.grantReadWriteData(agentToolsFunction);

    const gatewayRole = new iam.Role(this, 'AgentCoreGatewayRole', {
      roleName: 'personal-finance-v1-agentcore-gateway',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Gateway execution role that invokes Olbia finance tools Lambda.',
    });
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [agentToolsFunction.functionArn],
    }));
    agentToolsFunction.addPermission('AllowAgentCoreGatewayInvoke', {
      principal: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
    });

    const harnessExecutionRole = new iam.Role(this, 'AgentCoreHarnessExecutionRole', {
      roleName: 'personal-finance-v1-agentcore-harness',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          // Harness provisions a managed Runtime under the hood; both ARN shapes must match.
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: 'Execution role for Olbia AgentCore Harness.',
    });
    harnessExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: ['*'],
    }));
    harnessExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeGateway',
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:GetMemory',
        'bedrock-agentcore:RetrieveMemoryRecords',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`,
      ],
    }));

    const agentcoreProvisionerFunction = new NodejsFunction(this, 'AgentCoreProvisionerFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-agentcore-provisioner',
      logGroup: this.createLogGroup('AgentCoreProvisionerLogGroup', 'personal-finance-v1-agentcore-provisioner'),
      entry: path.join(__dirname, '..', 'lambda', 'agentcore-provisioner.ts'),
      handler: 'handler',
      description: 'Creates/updates AgentCore Gateway + Harness for Olbia assistant.',
      timeout: Duration.minutes(15),
      memorySize: 256,
    });
    // Harness/Gateway create a web of control-plane resources (workload identity,
    // managed runtime, endpoints). Scope is the provisioner custom resource only.
    agentcoreProvisionerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:*',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));
    for (const serviceLinkedRole of [
      {
        serviceName: 'runtime-identity.bedrock-agentcore.amazonaws.com',
        roleName: 'AWSServiceRoleForBedrockAgentCoreRuntimeIdentity',
      },
      {
        serviceName: 'network.bedrock-agentcore.amazonaws.com',
        roleName: 'AWSServiceRoleForBedrockAgentCoreNetwork',
      },
      {
        serviceName: 'bedrock-agentcore.amazonaws.com',
        roleName: 'AWSServiceRoleForBedrockAgentCoreGatewayNetwork',
      },
      {
        serviceName: 'identity-network.bedrock-agentcore.amazonaws.com',
        roleName: 'AWSServiceRoleForBedrockAgentCoreIdentity',
      },
    ] as const) {
      agentcoreProvisionerFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:CreateServiceLinkedRole'],
        resources: [
          `arn:aws:iam::*:role/aws-service-role/${serviceLinkedRole.serviceName}/${serviceLinkedRole.roleName}`,
        ],
        conditions: {
          StringEquals: {
            'iam:AWSServiceName': serviceLinkedRole.serviceName,
          },
        },
      }));
    }

    // Prompt Management: repo seeds DRAFT + bootstrap version.
    // Runtime promote/rollback = create a new Prompt version, then move the SSM pointer
    // (custom resource seeds the pointer once and does not overwrite later stack updates).
    const systemPromptVersionParamName = '/personal-finance-v1/agent/system-prompt-version-arn';
    const olbiaSystemPrompt = new cdk.CfnResource(this, 'OlbiaSystemPrompt', {
      type: 'AWS::Bedrock::Prompt',
      properties: {
        Name: OLBIA_SYSTEM_PROMPT_NAME,
        Description: 'System prompt for the Olbia finance AgentCore Harness.',
        DefaultVariant: OLBIA_SYSTEM_PROMPT_VARIANT,
        Variants: [{
          Name: OLBIA_SYSTEM_PROMPT_VARIANT,
          TemplateType: 'TEXT',
          ModelId: OLBIA_SYSTEM_PROMPT_MODEL_ID,
          InferenceConfiguration: {
            Text: {
              Temperature: OLBIA_SYSTEM_PROMPT_INFERENCE.temperature,
              MaxTokens: OLBIA_SYSTEM_PROMPT_INFERENCE.maxTokens,
            },
          },
          TemplateConfiguration: {
            Text: {
              Text: OLBIA_SYSTEM_PROMPT,
            },
          },
        }],
      },
    });
    const olbiaSystemPromptVersion = new cdk.CfnResource(this, 'OlbiaSystemPromptVersion', {
      type: 'AWS::Bedrock::PromptVersion',
      properties: {
        PromptArn: olbiaSystemPrompt.getAtt('Arn'),
        Description: 'bootstrap',
      },
    });
    olbiaSystemPromptVersion.addDependency(olbiaSystemPrompt);

    const seedPromptPointer = new cr.AwsCustomResource(this, 'SeedSystemPromptVersionPointer', {
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: systemPromptVersionParamName,
          Type: 'String',
          Value: olbiaSystemPromptVersion.getAtt('Arn'),
          Overwrite: true,
          Description: 'Active Bedrock Prompt Management version ARN for Olbia assistant (promote/rollback without deploy).',
        },
        physicalResourceId: cr.PhysicalResourceId.of('olbia-system-prompt-version-pointer'),
      },
      // Intentionally no onUpdate: runtime promote/rollback must not be clobbered by redeploys.
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: { Name: systemPromptVersionParamName },
        // Ignore if already deleted / retained.
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
    });
    seedPromptPointer.node.addDependency(olbiaSystemPromptVersion);

    const agentcoreProvider = new cr.Provider(this, 'AgentCoreProvider', {
      onEventHandler: agentcoreProvisionerFunction,
      logGroup: this.createLogGroup('AgentCoreProviderLogGroup', 'personal-finance-v1-agentcore-provider'),
    });
    const agentcoreResources = new cdk.CustomResource(this, 'OlbiaAgentCore', {
      serviceToken: agentcoreProvider.serviceToken,
      properties: {
        HarnessName: 'OlbiaFinance',
        MemoryName: 'OlbiaFinanceMemory',
        GatewayName: 'OlbiaFinanceGateway',
        TargetName: 'olbia-tools',
        HarnessExecutionRoleArn: harnessExecutionRole.roleArn,
        GatewayRoleArn: gatewayRole.roleArn,
        ToolsLambdaArn: agentToolsFunction.functionArn,
        ModelId: OLBIA_SYSTEM_PROMPT_MODEL_ID,
        // Reconcile AgentCore resources when the provisioner lifecycle logic changes.
        ProvisionerVersion: agentcoreProvisionerFunction.currentVersion.version,
        // Force replace when tools Lambda changes identity.
        ToolsLambdaVersion: agentToolsFunction.currentVersion.version,
      },
    });
    const harnessArn = agentcoreResources.getAttString('HarnessArn');
    const agentMemoryId = agentcoreResources.getAttString('MemoryId');

    // Conversational memory is isolated from the ledger and its financial source of truth.
    apiFunction.addEnvironment('AGENT_MEMORY_ID', agentMemoryId);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:DeleteMemoryRecord'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`],
    }));

    const agentProxyFunction = new NodejsFunction(this, 'AgentProxyFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-agent-proxy',
      logGroup: this.createLogGroup('AgentProxyLogGroup', 'personal-finance-v1-agent-proxy'),
      entry: path.join(__dirname, '..', 'lambda', 'agent-proxy.ts'),
      handler: 'handler',
      description: 'Cognito-authorized REST API → Prompt Management + AgentCore InvokeHarness (SSE stream).',
      timeout: Duration.seconds(120),
      memorySize: 512,
      environment: {
        ...dataStorageEnvironment,
        HARNESS_ARN: harnessArn,
        SYSTEM_PROMPT_VERSION_PARAM: systemPromptVersionParamName,
        SYSTEM_PROMPT_CACHE_TTL_MS: '30000',
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        WEB_APP_URL: webAppUrl,
      },
    });
    agentProxyFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeHarness',
        'bedrock-agentcore:InvokeAgentRuntime',
      ],
      resources: ['*'],
    }));
    agentProxyFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetPrompt'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:prompt/*`,
      ],
    }));
    // Do not import the SSM param via fromStringParameterName — CFN would resolve it
    // before the seed custom resource creates it on first deploy.
    agentProxyFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${systemPromptVersionParamName}`,
      ],
    }));

    // HTTP APIs buffer Lambda responses. The dedicated REST API uses Lambda's
    // response-streaming integration, so browser auth and CORS stay at API Gateway.
    const agentChatApi = new apigateway.RestApi(this, 'AgentChatRestApi', {
      restApiName: 'personal-finance-v1-agent-chat',
      description: 'Authenticated streamed assistant chat API.',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'prod',
        throttlingBurstLimit: 5,
        throttlingRateLimit: 2,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [webAppUrl],
        allowMethods: ['POST'],
        allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
        maxAge: Duration.hours(1),
      },
    });
    const agentChatAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'AgentChatCognitoAuthorizer', {
      cognitoUserPools: [userPool],
    });
    const agentChatResource = agentChatApi.root.addResource('agent').addResource('chat');
    agentChatResource.addMethod('POST', new apigateway.LambdaIntegration(agentProxyFunction, {
      proxy: true,
      timeout: Duration.seconds(120),
      responseTransferMode: apigateway.ResponseTransferMode.STREAM,
      allowTestInvoke: false,
    }), {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: agentChatAuthorizer,
    });
    for (const [id, type] of [
      ['AgentChatGateway4xxCors', apigateway.ResponseType.DEFAULT_4XX],
      ['AgentChatGateway5xxCors', apigateway.ResponseType.DEFAULT_5XX],
    ] as const) {
      new apigateway.GatewayResponse(this, id, {
        restApi: agentChatApi,
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': `'${webAppUrl}'`,
          Vary: "'Origin'",
        },
      });
    }

    const agentChatBufferedFunction = new NodejsFunction(this, 'AgentChatBufferedFunction', {
      ...lambdaDefaults,
      functionName: 'personal-finance-v1-agent-chat',
      logGroup: this.createLogGroup('AgentChatBufferedLogGroup', 'personal-finance-v1-agent-chat'),
      entry: path.join(__dirname, '..', 'lambda', 'agent-chat-buffered.ts'),
      handler: 'handler',
      description: 'JWT (APIGW) → Prompt Management + AgentCore InvokeHarness (buffered JSON).',
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...dataStorageEnvironment,
        HARNESS_ARN: harnessArn,
        SYSTEM_PROMPT_VERSION_PARAM: systemPromptVersionParamName,
        SYSTEM_PROMPT_CACHE_TTL_MS: '30000',
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });
    agentChatBufferedFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeHarness',
        'bedrock-agentcore:InvokeAgentRuntime',
      ],
      resources: ['*'],
    }));
    agentChatBufferedFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetPrompt'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:prompt/*`,
      ],
    }));
    agentChatBufferedFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${systemPromptVersionParamName}`,
      ],
    }));

    new cdk.CfnOutput(this, 'AgentCoreHarnessArn', { value: harnessArn });
    new cdk.CfnOutput(this, 'AgentCoreGatewayArn', {
      value: agentcoreResources.getAttString('GatewayArn'),
    });
    new cdk.CfnOutput(this, 'AgentChatUrl', {
      value: `${agentChatApi.url}agent/chat`,
      description: 'Native API Gateway REST SSE endpoint for POST agent chat.',
    });
    new cdk.CfnOutput(this, 'OlbiaSystemPromptVersionParam', {
      value: systemPromptVersionParamName,
      description: 'SSM pointer to the active Prompt Management version ARN (promote/rollback without deploy).',
    });
    new cdk.CfnOutput(this, 'OlbiaSystemPromptBootstrapVersionArn', {
      value: cdk.Token.asString(olbiaSystemPromptVersion.getAtt('Arn')),
      description: 'Bootstrap Prompt Management version; runtime may point elsewhere via SSM.',
    });

    // Low-threshold estimated charges alarm (single-user agent cost guardrail).
    new budgets.CfnBudget(this, 'AgentBedrockBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 15, unit: 'USD' },
        budgetName: 'personal-finance-v1-bedrock-agent',
        costFilters: { Service: ['Amazon Bedrock'] },
      },
      notificationsWithSubscribers: [{
        notification: {
          comparisonOperator: 'GREATER_THAN',
          threshold: 80,
          thresholdType: 'PERCENTAGE',
          notificationType: 'ACTUAL',
        },
        subscribers: [{
          subscriptionType: 'EMAIL',
          address: alertRecipientEmail.valueAsString,
        }],
      }],
    });
    // Textract reads statement PDFs from the KMS-encrypted raw bucket.
    rawEmailBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowTextractReadStatementPdfs',
      principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [
        rawEmailBucket.arnForObjects('manual-imports/santander-statement/*'),
        rawEmailBucket.arnForObjects('manual-imports/amex/*'),
      ],
    }));
    encryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowTextractDecryptStatementPdfs',
      principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` },
      },
    }));

    const applePayCaptureSecret = new secretsmanager.Secret(this, 'ApplePayCaptureSecret', {
      description: 'Bearer token used only by the personal Apple Pay Shortcut capture endpoint.',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'token',
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    const applePayCaptureFunction = new NodejsFunction(this, 'ApplePayCaptureFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-apple-pay-capture',
      logGroup: this.createLogGroup('ApplePayCaptureLogGroup', 'personal-finance-v1-apple-pay-capture'),
      entry: path.join(__dirname, '..', 'lambda', 'apple-pay-capture.ts'),
      handler: 'handler',
      description: 'Validates and atomically persists Apple Pay Shortcut observations.',
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        APPLE_PAY_CAPTURE_SECRET_ARN: applePayCaptureSecret.secretArn,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    metadataTable.grantReadWriteData(applePayCaptureFunction);
    applePayCaptureSecret.grantRead(applePayCaptureFunction);
    vapidSecret.grantRead(applePayCaptureFunction);

    const dailyBalancePushDlq = new sqs.Queue(this, 'DailyBalancePushDlq', {
      queueName: 'personal-finance-v1-daily-balance-push-dlq',
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });
    const dailyBalancePushFunction = new NodejsFunction(this, 'DailyBalancePushFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-daily-balance-push',
      logGroup: this.createLogGroup('DailyBalancePushLogGroup', 'personal-finance-v1-daily-balance-push'),
      entry: path.join(__dirname, '..', 'lambda', 'daily-balance-push.ts'),
      handler: 'handler',
      description: 'Sends the daily Olbia balance Web Push at 07:00 America/Chihuahua.',
      timeout: Duration.minutes(2),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        RAW_EMAIL_BUCKET_NAME: rawEmailBucket.bucketName,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    metadataTable.grantReadWriteData(dailyBalancePushFunction);
    vapidSecret.grantRead(dailyBalancePushFunction);
    new scheduler.Schedule(this, 'DailyBalancePushSchedule', {
      scheduleName: 'personal-finance-v1-daily-balance-push',
      description: 'Invokes the Olbia daily balance push at 07:00 America/Chihuahua.',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '0',
        hour: '7',
        day: '*',
        month: '*',
        year: '*',
        timeZone: cdk.TimeZone.of('America/Chihuahua'),
      }),
      timeWindow: scheduler.TimeWindow.off(),
      target: new LambdaInvoke(dailyBalancePushFunction, {
        deadLetterQueue: dailyBalancePushDlq,
        retryAttempts: 2,
      }),
    });

    const cardCyclePushDlq = new sqs.Queue(this, 'CardCyclePushDlq', {
      queueName: 'personal-finance-v1-card-cycle-push-dlq',
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });
    const cardCyclePushFunction = new NodejsFunction(this, 'CardCyclePushFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-card-cycle-push',
      logGroup: this.createLogGroup('CardCyclePushLogGroup', 'personal-finance-v1-card-cycle-push'),
      entry: path.join(__dirname, '..', 'lambda', 'card-cycle-push.ts'),
      handler: 'handler',
      description: 'Sends Web Push reminders on card cut-off and payment days at 07:05 America/Chihuahua.',
      timeout: Duration.minutes(2),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    metadataTable.grantReadWriteData(cardCyclePushFunction);
    vapidSecret.grantRead(cardCyclePushFunction);
    new scheduler.Schedule(this, 'CardCyclePushSchedule', {
      scheduleName: 'personal-finance-v1-card-cycle-push',
      description: 'Invokes card cut-off and payment push reminders at 07:05 America/Chihuahua.',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '5',
        hour: '7',
        day: '*',
        month: '*',
        year: '*',
        timeZone: cdk.TimeZone.of('America/Chihuahua'),
      }),
      timeWindow: scheduler.TimeWindow.off(),
      target: new LambdaInvoke(cardCyclePushFunction, {
        deadLetterQueue: cardCyclePushDlq,
        retryAttempts: 2,
      }),
    });

    const bitsoApiSecret = new secretsmanager.Secret(this, 'BitsoApiSecret', {
      description: 'Bitso API credentials and Cognito owner sub for patrimonio sync. Replace pending placeholders.',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        apiKey: 'pending',
        apiSecret: 'pending',
        owner: 'pending',
      })),
    });
    const bitsoSyncDlq = new sqs.Queue(this, 'BitsoSyncDlq', {
      queueName: 'personal-finance-v1-bitso-sync-dlq',
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });
    const bitsoSyncFunction = new NodejsFunction(this, 'BitsoSyncFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-bitso-sync',
      logGroup: this.createLogGroup('BitsoSyncLogGroup', 'personal-finance-v1-bitso-sync'),
      entry: path.join(__dirname, '..', 'lambda', 'bitso-sync.ts'),
      handler: 'handler',
      description: 'Syncs Bitso balances into patrimonio snapshots at 06:30 America/Chihuahua.',
      timeout: Duration.minutes(2),
      environment: {
        ...dataStorageEnvironment,
        BITSO_SECRET_ARN: bitsoApiSecret.secretArn,
        ALERT_SENDER_EMAIL: senderEmail.valueAsString,
        ALERT_RECIPIENT_EMAIL: alertRecipientEmail.valueAsString,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    rawEmailBucket.grantReadWrite(bitsoSyncFunction);
    metadataTable.grantReadWriteData(bitsoSyncFunction);
    bitsoApiSecret.grantRead(bitsoSyncFunction);
    vapidSecret.grantRead(bitsoSyncFunction);
    bitsoSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
      conditions: { StringEquals: { 'ses:FromAddress': senderEmail.valueAsString } },
    }));
    new scheduler.Schedule(this, 'BitsoSyncSchedule', {
      scheduleName: 'personal-finance-v1-bitso-sync',
      description: 'Invokes Bitso patrimonio sync at 06:30 America/Chihuahua.',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '30',
        hour: '6',
        day: '*',
        month: '*',
        year: '*',
        timeZone: cdk.TimeZone.of('America/Chihuahua'),
      }),
      timeWindow: scheduler.TimeWindow.off(),
      target: new LambdaInvoke(bitsoSyncFunction, {
        deadLetterQueue: bitsoSyncDlq,
        retryAttempts: 2,
      }),
    });

    apiFunction.addEnvironment('BITSO_SECRET_ARN', bitsoApiSecret.secretArn);
    bitsoApiSecret.grantRead(apiFunction);

    const ibkrApiSecret = new secretsmanager.Secret(this, 'IbkrApiSecret', {
      description: 'IBKR Flex token/queryId, Banxico token, and Cognito owner sub for patrimonio sync. Replace pending placeholders.',
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        flexToken: 'pending',
        flexQueryId: 'pending',
        banxicoToken: 'pending',
        owner: 'pending',
      })),
    });
    const ibkrSyncDlq = new sqs.Queue(this, 'IbkrSyncDlq', {
      queueName: 'personal-finance-v1-ibkr-sync-dlq',
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });
    const ibkrSyncFunction = new NodejsFunction(this, 'IbkrSyncFunction', {
      ...pushLambdaDefaults,
      functionName: 'personal-finance-v1-ibkr-sync',
      logGroup: this.createLogGroup('IbkrSyncLogGroup', 'personal-finance-v1-ibkr-sync'),
      entry: path.join(__dirname, '..', 'lambda', 'ibkr-sync.ts'),
      handler: 'handler',
      description: 'Syncs IBKR Flex positions into patrimonio snapshots at 06:45 America/Chihuahua.',
      timeout: Duration.minutes(3),
      environment: {
        ...dataStorageEnvironment,
        IBKR_SECRET_ARN: ibkrApiSecret.secretArn,
        ALERT_SENDER_EMAIL: senderEmail.valueAsString,
        ALERT_RECIPIENT_EMAIL: alertRecipientEmail.valueAsString,
        VAPID_SECRET_ARN: vapidSecret.secretArn,
        WEB_APP_URL: webAppUrl,
      },
    });
    rawEmailBucket.grantReadWrite(ibkrSyncFunction);
    metadataTable.grantReadWriteData(ibkrSyncFunction);
    ibkrApiSecret.grantRead(ibkrSyncFunction);
    vapidSecret.grantRead(ibkrSyncFunction);
    ibkrSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
      conditions: { StringEquals: { 'ses:FromAddress': senderEmail.valueAsString } },
    }));
    new scheduler.Schedule(this, 'IbkrSyncSchedule', {
      scheduleName: 'personal-finance-v1-ibkr-sync',
      description: 'Invokes IBKR patrimonio Flex sync at 06:45 America/Chihuahua.',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '45',
        hour: '6',
        day: '*',
        month: '*',
        year: '*',
        timeZone: cdk.TimeZone.of('America/Chihuahua'),
      }),
      timeWindow: scheduler.TimeWindow.off(),
      target: new LambdaInvoke(ibkrSyncFunction, {
        deadLetterQueue: ibkrSyncDlq,
        retryAttempts: 2,
      }),
    });

    apiFunction.addEnvironment('IBKR_SECRET_ARN', ibkrApiSecret.secretArn);
    ibkrApiSecret.grantRead(apiFunction);

    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'personal-finance-v1',
      description: 'Authenticated personal-finance API.',
      createDefaultStage: true,
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.PATCH, apigatewayv2.CorsHttpMethod.PUT, apigatewayv2.CorsHttpMethod.DELETE],
        allowOrigins: [`https://${webDomainName}`],
        maxAge: Duration.hours(1),
      },
    });
    const defaultApiStage = httpApi.defaultStage?.node.defaultChild;
    if (defaultApiStage instanceof apigatewayv2.CfnStage) {
      defaultApiStage.defaultRouteSettings = {
        throttlingBurstLimit: 10,
        throttlingRateLimit: 5,
      };
    }
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwtAuthorizer',
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const apiIntegration = new HttpLambdaIntegration('ApiLambdaIntegration', apiFunction);
    const applePayCaptureIntegration = new HttpLambdaIntegration('ApplePayCaptureIntegration', applePayCaptureFunction);
    const agentChatIntegration = new HttpLambdaIntegration('AgentChatBufferedIntegration', agentChatBufferedFunction);
    for (const route of [
      'GET /events',
      'POST /events/manual',
      'GET /exceptions',
      'GET /exceptions/{exceptionId}/raw',
      'POST /exceptions/{exceptionId}/retry',
      'DELETE /exceptions/{exceptionId}',
      'GET /events/{eventId}',
      'GET /events/{eventId}/raw',
      'PATCH /events/{eventId}',
      'GET /months/{month}',
      'PUT /months/{month}',
      'GET /months/{month}/payslips/{uuid}',
      'POST /imports/nomina',
      'POST /imports/santander/preview',
      'POST /imports/santander/{importId}/apply',
      'POST /imports/amex/preview',
      'GET /imports/amex/{importId}',
      'POST /imports/amex/{importId}/apply',
      'POST /imports/santander-statement/preview',
      'GET /imports/santander-statement/{importId}',
      'POST /imports/santander-statement/{importId}/apply',
      'GET /push/subscriptions',
      'PUT /push/subscriptions/{subscriptionId}',
      'DELETE /push/subscriptions/{subscriptionId}',
      'GET /cards',
      'PUT /cards/{cardId}',
      'DELETE /cards/{cardId}',
      'GET /wealth',
      'POST /wealth/accounts/{accountId}/snapshots',
      'POST /wealth/liabilities/{cardId}/snapshots',
      'POST /wealth/sync/bitso',
      'POST /wealth/sync/ibkr',
      'GET /categories',
      'PUT /categories',
      'POST /categories/ensure-defaults',
      'GET /categories/rules',
      'POST /categories/rules',
      'GET /agent/month-snapshot',
      'GET /agent/spend-by-category',
      'GET /agent/spend-by-merchant',
      'GET /agent/compare-months',
      'GET /agent/movements',
      'GET /agent/wealth-snapshot',
      'POST /agent/propose-recategorize',
      'POST /agent/chat',
    ]) {
      const pathName = route.split(' ')[1];
      const methodName = route.split(' ')[0] as apigatewayv2.HttpMethod;
      httpApi.addRoutes({
        path: pathName,
        methods: [methodName],
        integration: pathName === '/agent/chat' ? agentChatIntegration : apiIntegration,
        authorizer,
      });
    }
    httpApi.addRoutes({
      path: '/captures/apple-pay',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: applePayCaptureIntegration,
    });

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
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'apps', 'web', 'dist')),
        s3deploy.Source.data('runtime-config.js', `window.__LEDGER_CONFIG__ = ${JSON.stringify({
          apiBaseUrl: httpApi.apiEndpoint.replace(/\/$/, ''),
          agentChatUrl: `${agentChatApi.url}agent/chat`,
          cognitoUserPoolId: userPool.userPoolId,
          cognitoUserPoolClientId: userPoolClient.userPoolClientId,
          region: this.region,
          vapidPublicKey,
          webAppUrl,
        })};`),
      ],
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
    const applePayCaptureErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'ApplePayCaptureErrorsAlarm', {
      metric: applePayCaptureFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
    });
    const applePayCaptureThrottleAlarm = new cdk.aws_cloudwatch.Alarm(this, 'ApplePayCaptureThrottlesAlarm', {
      metric: applePayCaptureFunction.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const deadLetterAlarm = new cdk.aws_cloudwatch.Alarm(this, 'DeadLetterMessagesAlarm', {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const dailyBalancePushErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'DailyBalancePushErrorsAlarm', {
      metric: dailyBalancePushFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const dailyBalancePushDlqAlarm = new cdk.aws_cloudwatch.Alarm(this, 'DailyBalancePushDlqAlarm', {
      metric: dailyBalancePushDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const cardCyclePushErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'CardCyclePushErrorsAlarm', {
      metric: cardCyclePushFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const cardCyclePushDlqAlarm = new cdk.aws_cloudwatch.Alarm(this, 'CardCyclePushDlqAlarm', {
      metric: cardCyclePushDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const bitsoSyncErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'BitsoSyncErrorsAlarm', {
      metric: bitsoSyncFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const bitsoSyncDlqAlarm = new cdk.aws_cloudwatch.Alarm(this, 'BitsoSyncDlqAlarm', {
      metric: bitsoSyncDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const ibkrSyncErrorAlarm = new cdk.aws_cloudwatch.Alarm(this, 'IbkrSyncErrorsAlarm', {
      metric: ibkrSyncFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const ibkrSyncDlqAlarm = new cdk.aws_cloudwatch.Alarm(this, 'IbkrSyncDlqAlarm', {
      metric: ibkrSyncDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
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
    new cdk.CfnOutput(this, 'ApplePayCaptureUrl', { value: `${httpApi.apiEndpoint}/captures/apple-pay` });
    new cdk.CfnOutput(this, 'ApplePayCaptureSecretArn', { value: applePayCaptureSecret.secretArn });
    new cdk.CfnOutput(this, 'BitsoApiSecretArn', { value: bitsoApiSecret.secretArn });
    new cdk.CfnOutput(this, 'IbkrApiSecretArn', { value: ibkrApiSecret.secretArn });
    new cdk.CfnOutput(this, 'WebPushVapidSecretArn', { value: vapidSecret.secretArn });
    new cdk.CfnOutput(this, 'WebDistributionUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'WebCustomDomainUrl', { value: `https://${webDomainName}` });
    new cdk.CfnOutput(this, 'EmailReceiptErrorsAlarmName', { value: receiptErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'IngestionErrorsAlarmName', { value: ingestionErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'ApplePayCaptureErrorsAlarmName', { value: applePayCaptureErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'ApplePayCaptureThrottlesAlarmName', { value: applePayCaptureThrottleAlarm.alarmName });
    new cdk.CfnOutput(this, 'DeadLetterMessagesAlarmName', { value: deadLetterAlarm.alarmName });
    new cdk.CfnOutput(this, 'DailyBalancePushErrorsAlarmName', { value: dailyBalancePushErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'DailyBalancePushDlqAlarmName', { value: dailyBalancePushDlqAlarm.alarmName });
    new cdk.CfnOutput(this, 'CardCyclePushErrorsAlarmName', { value: cardCyclePushErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'CardCyclePushDlqAlarmName', { value: cardCyclePushDlqAlarm.alarmName });
    new cdk.CfnOutput(this, 'BitsoSyncErrorsAlarmName', { value: bitsoSyncErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'BitsoSyncDlqAlarmName', { value: bitsoSyncDlqAlarm.alarmName });
    new cdk.CfnOutput(this, 'IbkrSyncErrorsAlarmName', { value: ibkrSyncErrorAlarm.alarmName });
    new cdk.CfnOutput(this, 'IbkrSyncDlqAlarmName', { value: ibkrSyncDlqAlarm.alarmName });
  }

  private createLogGroup(id: string, functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class PersonalFinanceWebCertificateStack extends Stack {
  public readonly certificate: acm.ICertificate;
  public readonly domainName: string;

  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Object.entries({ Project: 'personal-finance-system', Environment: 'prod', ManagedBy: 'cdk' })
      .forEach(([key, value]) => cdk.Tags.of(this).add(key, value));

    this.domainName = 'finance.castrodavid.dev';
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'CastroDavidDevZone', {
      hostedZoneId: 'Z09057602V6K42SQPOMLC',
      zoneName: 'castrodavid.dev',
    });

    this.certificate = new acm.Certificate(this, 'WebCertificate', {
      domainName: this.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
  }
}

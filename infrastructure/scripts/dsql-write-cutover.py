#!/usr/bin/env python3
"""One-time coordinated cutover, exclusively in the approved deploy-production job.

Uses already-deployed authority control and native backups. No local releases,
DynamoDB edits, reverse replication, or raw financial output.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def aws(*args):
    identity = json.loads(subprocess.check_output(['aws','sts','get-caller-identity'],text=True))
    if identity['Account'] != '225989371926':
        raise RuntimeError('Unexpected AWS account')
    return json.loads(subprocess.check_output(['aws',*args,'--output','json'],text=True))


def operator(function, action):
    with tempfile.TemporaryDirectory() as directory:
        response=Path(directory)/'response.json'
        metadata=aws('lambda','invoke','--function-name',function,'--cli-binary-format','raw-in-base64-out',
                     '--payload',json.dumps({'action':action}),'--cli-read-timeout','180',str(response))
        if metadata.get('FunctionError') or metadata['StatusCode'] != 200:
            raise RuntimeError('Authority operator failed; storage stays at its last confirmed mode')
        result=json.loads(response.read_text())
        print(json.dumps({'action':action,**result}))
        return result


def wait_backup(service, identifier):
    deadline=time.monotonic()+2700
    while time.monotonic()<deadline:
        if service=='dynamodb':
            result=aws('dynamodb','describe-backup','--backup-arn',identifier)
            status=result['BackupDescription']['BackupDetails']['BackupStatus']
            if status=='AVAILABLE': return
        else:
            result=aws('backup','describe-backup-job','--backup-job-id',identifier)
            status=result['State']
            if status=='COMPLETED': return
        if status in ['FAILED','ABORTED','EXPIRED','DELETED','PARTIAL']:
            raise RuntimeError('Native backup did not complete; authority remains paused')
        time.sleep(15)
    raise RuntimeError('Native backup timeout; authority remains paused')


def main(phase):
    if os.environ.get('GITHUB_ACTIONS')!='true':
        raise RuntimeError('Cutover belongs exclusively to deploy-production')
    flag=Path('infrastructure/lib/storage-cutover.ts').read_text()
    if 'SQL_AUTHORITY = true;' not in flag:
        print('SQL activation disabled in this approved revision')
        return
    outputs={item['OutputKey']:item['OutputValue'] for item in aws('cloudformation','describe-stacks','--stack-name','PersonalFinanceV1')['Stacks'][0]['Outputs']}
    function=outputs['DsqlCutoverFunction']
    mode=operator(function,'status')['mode']
    if mode=='sql':
        print('SQL is already authoritative; subsequent deployment preserves authority')
        if phase=='activate': operator(function,'smoke')
        return
    run=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
    if phase=='prepare':
        if operator(function,'pause')['mode']!='paused': raise RuntimeError('Pause not confirmed')
        # All writers are already routed through deployed per-command authority checks.
        # Allow in-flight native DynamoDB requests to finish; subsequent work is paused.
        time.sleep(60)
        print('Writers paused; reviewed infrastructure update installs encrypted-backup permission')
    elif phase=='backup-source':
        if mode!='paused': raise RuntimeError('Expected paused authority for source backup')
        backup=aws('dynamodb','create-backup','--table-name',outputs['DsqlSourceTable'],'--backup-name','olbia-pre-sql-'+run)
        wait_backup('dynamodb',backup['BackupDetails']['BackupArn'])
        print('Dated DynamoDB backup AVAILABLE; table retained')
    elif phase=='activate':
        if mode!='paused': raise RuntimeError('Expected paused authority')
        # Called after final reconciliation and the independent historical/read gates.
        backup=aws('backup','start-backup-job','--backup-vault-name',outputs['DsqlBackupVault'],
                   '--resource-arn',outputs['DsqlClusterArn'],'--iam-role-arn',outputs['DsqlBackupRole'],
                   '--idempotency-token','olbia-cutover-'+run,'--recovery-point-tags','migration=sql-write-cutover')
        wait_backup('backup',backup['BackupJobId'])
        print('Native DSQL backup COMPLETED; daily native backups enabled')
        if operator(function,'smoke')!={'verified':True,'rolledBack':True}: raise RuntimeError('Write smoke failed')
        if operator(function,'activate')['mode']!='sql': raise RuntimeError('SQL activation not confirmed')
    else:
        raise RuntimeError('Unknown cutover phase')


if __name__=='__main__':
    main(sys.argv[1])

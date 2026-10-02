import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cutover',Path(__file__).with_name('dsql-write-cutover.py'))
cutover=importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)
OUTPUTS={'DsqlCutoverFunction':'operator','DsqlSourceTable':'metadata','DsqlBackupVault':'vault','DsqlClusterArn':'cluster','DsqlBackupRole':'backup-role'}


class CutoverTests(unittest.TestCase):
    def run_phase(self,phase,mode='paused',backup_failed=False):
        calls=[]
        def aws(*args):
            calls.append(('aws',*args))
            if args[:2]==('cloudformation','describe-stacks'):
                return {'Stacks':[{'Outputs':[{'OutputKey':k,'OutputValue':v} for k,v in OUTPUTS.items()]}]}
            if args[:2]==('dynamodb','create-backup'): return {'BackupDetails':{'BackupArn':'source-backup'}}
            if args[:2]==('backup','start-backup-job'): return {'BackupJobId':'sql-backup'}
            raise AssertionError(args)
        def operator(function,action):
            calls.append(('operator',action))
            return {'verified':True,'rolledBack':True} if action=='smoke' else {'mode':mode if action=='status' else 'sql' if action=='activate' else 'paused'}
        def wait(service,identifier):
            calls.append(('wait',service,identifier))
            if backup_failed: raise RuntimeError('backup failed')
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','GITHUB_RUN_ID':'42','GITHUB_RUN_ATTEMPT':'1'}),patch.object(Path,'read_text',return_value='export const SQL_AUTHORITY = true;'),patch.object(cutover,'aws',side_effect=aws),patch.object(cutover,'operator',side_effect=operator),patch.object(cutover,'wait_backup',side_effect=wait),patch.object(cutover.time,'sleep'):
            if backup_failed:
                with self.assertRaisesRegex(RuntimeError,'backup failed'): cutover.main(phase)
            else: cutover.main(phase)
        return calls

    def test_pause_does_not_attempt_backup_before_reviewed_permission_deployment(self):
        calls=self.run_phase('prepare','dynamodb')
        self.assertIn(('operator','pause'),calls)
        self.assertFalse(any(c[:3]==('aws','dynamodb','create-backup') for c in calls))

    def test_source_backup_completes_without_activating_or_editing_source_records(self):
        calls=self.run_phase('backup-source')
        self.assertIn(('wait','dynamodb','source-backup'),calls)
        self.assertFalse(any(c==('operator','activate') for c in calls))
        self.assertFalse(any(c[0]=='aws' and any(action in c for action in ['put-item','update-item','delete-item']) for c in calls))

    def test_native_sql_backup_and_rolled_back_smoke_precede_activation(self):
        calls=self.run_phase('activate')
        self.assertLess(calls.index(('wait','backup','sql-backup')),calls.index(('operator','smoke')))
        self.assertLess(calls.index(('operator','smoke')),calls.index(('operator','activate')))

    def test_failed_backup_never_activates(self):
        self.assertNotIn(('operator','activate'),self.run_phase('activate',backup_failed=True))

    def test_subsequent_sql_deployment_does_not_pause_or_backup_frozen_source(self):
        calls=self.run_phase('prepare','sql')
        self.assertNotIn(('operator','pause'),calls)
        self.assertFalse(any(c[:3]==('aws','dynamodb','create-backup') for c in calls))


if __name__=='__main__': unittest.main()

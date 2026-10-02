import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('verify-dsql-deployment.sh')

# Exercise the real shell entrypoint with AWS responses, without production access.
AWS = '''#!/usr/bin/env python3
import json, os, pathlib, sys
a = sys.argv[1:]
with open(os.environ['AWS_CALLS'], 'a') as log:
    log.write(json.dumps(a) + '\\n')
operation = a[:2]
if operation == ['sts', 'get-caller-identity']:
    print(json.dumps({'Account': '225989371926', 'Arn': 'test-deployment-role'}))
elif operation == ['cloudformation', 'describe-stacks']:
    query = a[a.index('--query') + 1]
    print('operator' if 'DsqlCutoverFunction' in query else 'reader' if 'DsqlReadVerificationFunction' in query else 'state-machine')
elif operation == ['stepfunctions', 'start-execution']:
    print('execution')
elif operation == ['stepfunctions', 'describe-execution']:
    query = a[a.index('--query') + 1]
    if query == 'status':
        print(os.environ.get('RECONCILIATION_STATUS', 'SUCCEEDED'))
    else:
        print(json.dumps({'phase': 'done', 'projected': 0, 'equal': 4, 'lag': 0, 'mismatch': 0}))
elif operation == ['lambda', 'invoke']:
    payload = json.loads(a[a.index('--payload') + 1])
    action = payload.get('action', 'read')
    response = {'mode': os.environ.get('AUTHORITY', 'sql')} if action == 'status' else {'verified': True, 'rolledBack': True} if action == 'smoke' else {'verified': True, 'mismatches': 0}
    if os.environ.get('FAIL_GATE') == action:
        response = {'verified': False, 'rolledBack': False, 'mismatches': 1}
    pathlib.Path(a[-1]).write_text(json.dumps(response))
    metadata = {'StatusCode': 200}
    if os.environ.get('FAIL_INVOCATION') == action:
        metadata['FunctionError'] = 'Unhandled'
    print(json.dumps(metadata))
else:
    raise AssertionError(a)
'''


class RoutineVerificationTests(unittest.TestCase):
    def run_gate(self, **settings):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'aws'
            fake.write_text(AWS)
            fake.chmod(0o700)
            calls_file = root / 'calls.jsonl'
            env = {**os.environ, **settings, 'PATH': directory + os.pathsep + os.environ['PATH'],
                   'AWS_CALLS': str(calls_file), 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1'}
            result = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in calls_file.read_text().splitlines()]
            return result, calls

    def test_sql_verification_runs_once_without_authority_or_backup_mutations(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        executions = [call for call in calls if call[:2] == ['stepfunctions', 'start-execution']]
        self.assertEqual(len(executions), 1)
        self.assertEqual(executions[0][executions[0].index('--name') + 1], 'deploy-42-1-sql')
        payloads = [json.loads(call[call.index('--payload') + 1]) for call in calls if call[:2] == ['lambda', 'invoke']]
        self.assertEqual(payloads, [{'action': 'status'}, {}, {'action': 'smoke'}])
        self.assertFalse(any(call[0] in ['dynamodb', 'backup'] for call in calls))

    def test_unexpected_authority_never_starts_reconciliation(self):
        for mode in ['dynamodb', 'paused']:
            with self.subTest(mode=mode):
                result, calls = self.run_gate(AUTHORITY=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('cannot perform a cutover', result.stderr)
                self.assertFalse(any(call[0] == 'stepfunctions' for call in calls))

    def test_failed_authority_invocation_never_starts_reconciliation(self):
        result, calls = self.run_gate(FAIL_INVOCATION='status')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SQL authority check failed', result.stderr)
        self.assertFalse(any(call[0] == 'stepfunctions' for call in calls))

    def test_failed_reconciliation_never_runs_public_or_write_probe(self):
        result, calls = self.run_gate(RECONCILIATION_STATUS='FAILED')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(call[:2] == ['lambda', 'invoke'] for call in calls), 1)

    def test_public_read_failure_stops_before_write_smoke(self):
        result, calls = self.run_gate(FAIL_GATE='read')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Public read equivalence failed', result.stderr)
        self.assertFalse(any('"action":"smoke"' in call for call in calls))

    def test_write_smoke_must_confirm_rollback(self):
        result, _ = self.run_gate(FAIL_GATE='smoke')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Native SQL rollback verification failed', result.stderr)


if __name__ == '__main__':
    unittest.main()

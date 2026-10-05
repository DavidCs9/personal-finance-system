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
    print('operator' if 'DsqlCutoverFunction' in query else 'reader' if 'DsqlReadVerificationFunction' in query else 'schema' if 'DsqlSchemaFunction' in query else 'state-machine')
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
    response = {'mode': os.environ.get('AUTHORITY', 'sql')} if action == 'status' else {'verified': True, 'rolledBack': True, 'nativeLedger': True, 'nativeWealth': True, 'nativePush': True, 'nativeDeliveries': True, 'nativeThreads': True, 'nativeExceptions': True} if action == 'smoke' else {'verified': True, 'mode': 'native-sql', 'mismatches': 0, 'provenance': {'mismatches': 0}, 'evidence': {'mismatches': 0}}
    if action == 'retire-migration-evidence':
        response = {'verified': True, 'mode': 'native-sql', 'remainingTables': 41, 'domainTables': 38, 'controlTables': 3, 'migrationEvidenceTables': 0, 'removedTables': json.loads(os.environ.get('REMOVED_TABLES', '0'))}
        if os.environ.get('OMIT_REMOVED_TABLES'):
            response.pop('removedTables')
    if os.environ.get('FAIL_GATE') == action:
        response = {'verified': False, 'rolledBack': False, 'mismatches': 1}
    if os.environ.get('FAIL_AFTER_CLEANUP') == action:
        calls = [json.loads(line) for line in pathlib.Path(os.environ['AWS_CALLS']).read_text().splitlines()]
        if any('--payload' in call and json.loads(call[call.index('--payload') + 1]).get('action') == 'retire-migration-evidence' for call in calls):
            response = {'verified': False, 'rolledBack': False, 'mismatches': 1}
    if os.environ.get('LEGACY_PROBE') == action:
        response = {'verified': True, 'rolledBack': True, 'mismatches': 0}
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

    def test_unchanged_catalog_runs_every_financial_evidence_and_rollback_gate_once(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        executions = [call for call in calls if call[:2] == ['stepfunctions', 'start-execution']]
        self.assertEqual(len(executions), 1)
        self.assertEqual(executions[0][executions[0].index('--name') + 1], 'deploy-42-1-sql')
        payloads = [json.loads(call[call.index('--payload') + 1]) for call in calls if call[:2] == ['lambda', 'invoke']]
        self.assertEqual(payloads, [{'action': 'status'}, {}, {'action': 'smoke'}, {'action': 'retire-migration-evidence'}])
        self.assertIn('Native catalog unchanged', result.stdout)
        self.assertFalse(any(call[0] in ['dynamodb', 'backup'] for call in calls))

    def test_catalog_retirement_still_requires_complete_post_cleanup_checks(self):
        result, calls = self.run_gate(REMOVED_TABLES='26')
        self.assertEqual(result.returncode, 0, result.stderr)
        payloads = [json.loads(call[call.index('--payload') + 1]) for call in calls if call[:2] == ['lambda', 'invoke']]
        self.assertEqual(payloads, [{'action': 'status'}, {}, {'action': 'smoke'}, {'action': 'retire-migration-evidence'}, {}, {'action': 'smoke'}])

    def test_invalid_cleanup_proof_never_skips_the_post_cleanup_gates(self):
        for settings in [{'OMIT_REMOVED_TABLES': '1'}, *[{'REMOVED_TABLES': value} for value in ['null', '"0"', '-1', '1.5', '27']]]:
            with self.subTest(settings=settings):
                result, calls = self.run_gate(**settings)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('SQL catalog cleanup failed', result.stderr)
                self.assertEqual(sum(call[:2] == ['lambda', 'invoke'] for call in calls), 4)

    def test_failure_after_catalog_change_cannot_pass_the_release(self):
        for action in ['read', 'smoke']:
            with self.subTest(action=action):
                result, calls = self.run_gate(REMOVED_TABLES='1', FAIL_AFTER_CLEANUP=action)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Clean SQL', result.stderr)
                self.assertEqual(sum(call[:2] == ['lambda', 'invoke'] for call in calls), 5 if action == 'read' else 6)

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
        self.assertFalse(any('"action":"smoke"' in call or '"action":"retire-migration-evidence"' in call for call in calls))

    def test_legacy_success_cannot_satisfy_native_release_gates(self):
        for action in ['read', 'smoke']:
            with self.subTest(action=action):
                result, _ = self.run_gate(LEGACY_PROBE=action)
                self.assertNotEqual(result.returncode, 0)

    def test_cleanup_failure_prevents_success_and_post_cleanup_probes(self):
        for setting in ['FAIL_GATE', 'FAIL_INVOCATION']:
            result, calls = self.run_gate(**{setting: 'retire-migration-evidence'})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('cleanup', result.stderr)
            self.assertEqual(sum(call[:2] == ['lambda', 'invoke'] for call in calls), 4)

    def test_write_smoke_must_confirm_rollback(self):
        result, _ = self.run_gate(FAIL_GATE='smoke')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Native SQL rollback verification failed', result.stderr)


if __name__ == '__main__':
    unittest.main()

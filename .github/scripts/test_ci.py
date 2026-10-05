import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ci_scope', HERE / 'ci_scope.py')
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def test_only_nonempty_markdown_changes_take_the_short_path(self):
        self.assertTrue(scope.markdown_only(['README.md', 'docs/path with\na newline.md']))
        for paths in [[], ['README.md', 'package.json'], ['script.ts'], ['workflow.yml'], ['README.MD']]:
            self.assertFalse(scope.markdown_only(paths))

    def test_complete_git_diff_includes_deleted_and_renamed_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'CI test')
            git('config', 'user.email', 'ci@example.invalid')
            (root / 'source.ts').write_text('code')
            (root / 'old.md').write_text('docs')
            git('add', '.')
            git('commit', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            (root / 'source.ts').rename(root / 'renamed.md')
            (root / 'old.md').unlink()
            (root / 'with\na newline.md').write_text('docs')
            git('add', '.')
            git('commit', '-m', 'rename')
            paths = scope.changed_paths(base, cwd=root)
            self.assertEqual(set(paths), {'source.ts', 'renamed.md', 'old.md', 'with\na newline.md'})
            self.assertFalse(scope.markdown_only(paths))
            # Non-PR triggers and non-merge checkouts cannot take the short path.
            self.assertFalse(scope.docs_only_for_event('push', cwd=root))
            self.assertFalse(scope.docs_only_for_event('workflow_dispatch', cwd=root))
            self.assertFalse(scope.docs_only_for_event('pull_request', cwd=root))
            git('checkout', '-b', 'docs', base)
            (root / 'old.md').write_text('changed docs')
            git('commit', '-am', 'documentation')
            git('checkout', 'main')
            # A real merge diff proves only the PR contribution, not main's changes.
            git('reset', '--hard', base)
            git('merge', '--no-ff', 'docs', '-m', 'PR merge')
            self.assertTrue(scope.docs_only_for_event('pull_request', cwd=root))
            git('checkout', '-b', 'code')
            (root / 'source.ts').unlink()
            git('commit', '-am', 'delete code')
            git('checkout', 'main')
            git('merge', '--no-ff', 'code', '-m', 'PR merge')
            self.assertFalse(scope.docs_only_for_event('pull_request', cwd=root))

    def test_bad_git_base_cannot_return_a_documentation_proof(self):
        with self.assertRaises(subprocess.CalledProcessError):
            scope.changed_paths('not-a-git-object')

    def test_matrix_covers_all_current_and_future_test_workspaces(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text(json.dumps({'workspaces': ['services/*']}))
            for name, test in [('api', True), ('ledger', True), ('future', True), ('no-tests', False)]:
                folder = root / 'services' / name
                folder.mkdir(parents=True)
                (folder / 'package.json').write_text(json.dumps({'name': f'@finance/{name}', 'scripts': {'test': 'vitest run'} if test else {}}))
            entries = scope.test_matrix(root)['include']
            self.assertEqual([e['shard'] for e in entries if e['workspaces'] == ['@finance/api']], ['1/2', '2/2'])
            self.assertEqual([e['shard'] for e in entries if e['workspaces'] == ['@finance/ledger']], ['1/2', '2/2'])
            self.assertEqual(entries[-1]['workspaces'], ['@finance/future'])
            (root / 'services' / 'ledger' / 'package.json').unlink()
            with self.assertRaises(ValueError):
                scope.test_matrix(root)


class RequiredGateTests(unittest.TestCase):
    def gate(self, docs='false', scope_result='success', results=('success', 'success', 'success')):
        env = {**os.environ, 'DOCS_ONLY': docs, 'SCOPE_RESULT': scope_result,
               **dict(zip(['FAST_RESULT', 'TEST_RESULT', 'BUILD_RESULT'], results))}
        return subprocess.run(['bash', str(HERE / 'quality_gate.sh')], env=env, capture_output=True).returncode

    def test_only_complete_code_validation_can_pass(self):
        self.assertEqual(self.gate(), 0)
        for index in range(3):
            for status in ['failure', 'cancelled', 'skipped', '']:
                results = ['success'] * 3
                results[index] = status
                self.assertNotEqual(self.gate(results=results), 0)

    def test_scope_must_succeed_and_prove_the_selected_path(self):
        self.assertEqual(self.gate(docs='true', results=('skipped',) * 3), 0)
        for result in ['failure', 'cancelled', 'skipped', '']:
            self.assertNotEqual(self.gate(scope_result=result), 0)
        for docs in ['', 'unknown']:
            self.assertNotEqual(self.gate(docs=docs), 0)
        self.assertNotEqual(self.gate(docs='true'), 0)
        self.assertNotEqual(self.gate(results=('skipped',) * 3), 0)


class WorkspaceCheckTests(unittest.TestCase):
    def run_checks(self, **settings):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            npm = root / 'npm'
            npm.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
if sys.argv[1:] == ['query', '.workspace']:
    if os.environ.get('FAIL_QUERY'): sys.exit(1)
    print(json.dumps([
        {'name': '@finance/api', 'scripts': {'check': 'tsc'}},
        {'name': '@finance/future', 'scripts': {'check': 'custom-check'}},
        {'name': '@finance/without-check', 'scripts': {}},
    ] if not os.environ.get('EMPTY_QUERY') else []))
else:
    with pathlib.Path(os.environ['CHECK_CALLS']).open('a') as output:
        output.write(json.dumps(sys.argv[1:]) + '\\n')
    if sys.argv[-1] == os.environ.get('FAIL_WORKSPACE'): sys.exit(1)
''')
            npm.chmod(0o755)
            calls = root / 'calls.jsonl'
            env = {**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'CHECK_CALLS': str(calls), **settings}
            result = subprocess.run(['bash', str(HERE / 'check_workspaces.sh')], env=env, capture_output=True)
            return result.returncode, [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def test_discovers_current_and_future_checks_without_requiring_test_scripts(self):
        result, calls = self.run_checks()
        self.assertEqual(result, 0)
        self.assertEqual(sorted(calls), sorted([
            ['run', 'check', '--workspace', '@finance/api'],
            ['run', 'check', '--workspace', '@finance/future'],
        ]))

    def test_failed_discovery_or_check_cannot_pass(self):
        for settings in [{'FAIL_QUERY': '1'}, {'EMPTY_QUERY': '1'}, {'FAIL_WORKSPACE': '@finance/api'}]:
            with self.subTest(settings=settings):
                result, _ = self.run_checks(**settings)
                self.assertNotEqual(result, 0)


if __name__ == '__main__':
    unittest.main()

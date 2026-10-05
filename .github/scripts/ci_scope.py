"""Conservative PR scope and native Vitest/GitHub matrix configuration.

Workflow-level path filters cannot emit the required quality verdict. Use Git's
complete merge diff (no API file-count limit), keeping both paths of a rename.
"""
import glob
import json
import os
from pathlib import Path
import subprocess


def markdown_only(paths):
    return bool(paths) and all(path.endswith('.md') for path in paths)


def changed_paths(base, head='HEAD', cwd=None):
    result = subprocess.run(
        ['git', 'diff', '--no-renames', '--name-only', '-z', base, head, '--'],
        cwd=cwd, check=True, capture_output=True,
    )
    return result.stdout.decode('utf-8', errors='surrogateescape').split('\0')[:-1]


def docs_only_for_event(event, cwd=None):
    if event != 'pull_request':
        return False
    parents = subprocess.check_output(
        ['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], cwd=cwd, text=True,
    ).split()
    # GitHub checks out the PR merge commit. Unexpected/shallow input takes the
    # full path, never a guessed base or a partially listed set of files.
    if len(parents) != 3:
        return False
    return markdown_only(changed_paths('HEAD^1', cwd=cwd))


def test_matrix(root):
    root = Path(root)
    manifest = json.loads((root / 'package.json').read_text())
    names = set()
    for pattern in manifest['workspaces']:
        for directory in glob.glob(str(root / pattern)):
            package_file = Path(directory) / 'package.json'
            if package_file.is_file():
                package = json.loads(package_file.read_text())
                if package.get('scripts', {}).get('test'):
                    names.add(package['name'])
    include = []
    for name in ('@finance/api', '@finance/ledger'):
        if name not in names:
            raise ValueError(f'Missing required financial test workspace: {name}')
        names.remove(name)
        for shard in ('1/2', '2/2'):
            include.append({'suite': f'{name} {shard}', 'workspaces': [name], 'shard': shard})
    if names:
        include.append({'suite': 'other workspaces', 'workspaces': sorted(names), 'shard': ''})
    return {'include': include}


if __name__ == '__main__':
    docs_only = docs_only_for_event(os.environ['GITHUB_EVENT_NAME'])
    matrix = test_matrix(Path(__file__).resolve().parents[2])
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'docs_only={str(docs_only).lower()}\n')
        output.write(f'test_matrix={json.dumps(matrix, separators=(",", ":"))}\n')

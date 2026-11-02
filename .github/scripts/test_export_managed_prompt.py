import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

from export_managed_prompt import PART_BYTES, PART_COUNT, export_prompt, prompt_parts


def document(text):
    return {'defaultVariant': 'active', 'variants': [
        {'name': 'other'},
        {'name': 'active', 'modelId': 'example.model',
         'templateConfiguration': {'text': {'text': text}},
         'inferenceConfiguration': {'text': {'temperature': 0.2, 'maxTokens': 8192}}},
    ]}


class ManagedPromptExportTests(unittest.TestCase):
    def test_unicode_capacity_boundaries_roundtrip_without_truncation(self):
        for text in ['x' * 9345, 'á漢字' * 2000 + '\n\n', 'x' * (PART_BYTES - 1) + '漢' + '\n',
                     'x' * (PART_BYTES * PART_COUNT)]:
            with self.subTest(length=len(text)):
                parts = prompt_parts(text)
                self.assertEqual(''.join(parts), text)
                self.assertEqual(len(parts), PART_COUNT)
                self.assertTrue(all(len(p.encode('utf-8')) <= PART_BYTES for p in parts))

    def test_masks_every_part_before_export_and_preserves_trailing_newlines(self):
        text = 'Private fixture 100%\r\n' + 'á漢' * 2000 + '\n\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'environment'
            class MaskOutput(io.StringIO):
                def write(output, value):
                    self.assertFalse(path.exists(), 'All masks must precede environment export')
                    return super().write(value)
            output = MaskOutput()
            export_prompt(document(text), path, output)
            masks = [p.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
                     for p in prompt_parts(text) if p]
            self.assertEqual(output.getvalue(), ''.join(f'::add-mask::{p}\n' for p in masks))
            raw = path.read_bytes().decode('utf-8')
            parts = re.findall(r'OLBIA_SYSTEM_PROMPT_PART_\d+<<(\w+)\n(.*?)\n\1\n', raw, re.S)
            self.assertEqual(len(parts), PART_COUNT)
            self.assertEqual(''.join(p for _, p in parts), text)
            self.assertIn('OLBIA_SYSTEM_PROMPT_MAX_TOKENS=8192\n', raw)

    def test_capacity_or_bad_configuration_fails_without_private_output_or_export(self):
        script = Path(__file__).with_name('export_managed_prompt.py')
        for payload in [document('Private fixture' * 3000), document(''), {'defaultVariant': 'private fixture'}]:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'environment'
                result = subprocess.run([sys.executable, str(script)], input=json.dumps(payload),
                                        env={**os.environ, 'GITHUB_ENV': str(path)}, text=True, capture_output=True)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertNotIn('fixture', result.stderr)
                self.assertFalse(path.exists())

    def test_workflow_passes_every_private_part_to_diff_and_deploy(self):
        workflow = (Path(__file__).parents[1] / 'workflows' / 'ci-cd.yml').read_text()
        self.assertIn('python3 .github/scripts/export_managed_prompt.py', workflow)
        self.assertIn('set -euo pipefail', workflow)
        for index in range(1, PART_COUNT + 1):
            argument = f'--parameters PersonalFinanceV1:OlbiaSystemPromptTextPart{index}="$OLBIA_SYSTEM_PROMPT_PART_{index}"'
            self.assertEqual(workflow.count(argument), 2)


if __name__ == '__main__':
    unittest.main()

"""Transport the private managed DRAFT through native NoEcho parameters."""
import json
import math
import os
from pathlib import Path
import sys
import uuid


PART_COUNT = 8
PART_BYTES = 3500  # Below CloudFormation's 4096-byte parameter limit.


def prompt_parts(text):
    parts, current, size = [], [], 0
    for character in text:
        width = len(character.encode('utf-8'))
        if size + width > PART_BYTES:
            parts.append(''.join(current))
            current, size = [], 0
        current.append(character)
        size += width
    parts.append(''.join(current))
    if len(parts) > PART_COUNT:
        raise ValueError('Managed prompt exceeds private deployment transport capacity')
    return parts + [''] * (PART_COUNT - len(parts))


def export_prompt(document, env_path, output):
    variant = next(v for v in document['variants'] if v['name'] == document['defaultVariant'])
    text = variant['templateConfiguration']['text']['text']
    model = variant['modelId']
    inference = variant['inferenceConfiguration']['text']
    temperature, tokens = inference['temperature'], inference['maxTokens']
    if (not isinstance(text, str) or not text or '\0' in text
            or not isinstance(model, str) or not model or any(c in model for c in '\r\n\0')
            or type(tokens) is not int or tokens < 1
            or type(temperature) not in (int, float) or not math.isfinite(temperature)
            or not 0 <= temperature <= 1):
        raise ValueError('Invalid managed prompt configuration')
    parts = prompt_parts(text)
    # Register every multiline value before a later step can log its environment.
    for part in parts:
        if part:
            escaped = part.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
            print(f'::add-mask::{escaped}', file=output, flush=True)
    delimiter = f'OLBIA_PROMPT_{uuid.uuid4().hex}'
    with Path(env_path).open('a', encoding='utf-8', newline='') as environment:
        for index, part in enumerate(parts, 1):
            marker = f'{delimiter}_{index}'
            environment.write(f'OLBIA_SYSTEM_PROMPT_PART_{index}<<{marker}\n{part}\n{marker}\n')
        environment.write(f'OLBIA_SYSTEM_PROMPT_MODEL_ID={model}\n')
        environment.write(f'OLBIA_SYSTEM_PROMPT_TEMPERATURE={temperature}\n')
        environment.write(f'OLBIA_SYSTEM_PROMPT_MAX_TOKENS={tokens}\n')


def main():
    try:
        export_prompt(json.load(sys.stdin), os.environ['GITHUB_ENV'], sys.stdout)
    except (KeyError, ValueError, TypeError, StopIteration):
        # Provider payloads and exceptions may contain the private profile.
        print('Managed prompt export failed: invalid configuration or transport capacity exceeded.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

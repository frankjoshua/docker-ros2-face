"""Exercise the build wrapper without building or publishing real images."""
import json
import os
from pathlib import Path
import subprocess

import pytest


@pytest.fixture
def build(tmp_path):
    docker = tmp_path / 'docker'
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_CALLS'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[:2] == ['buildx', 'create']:
    print('test-builder')
if ' '.join(args[:2]) == os.environ.get('DOCKER_FAIL'):
    sys.exit(7)
''')
    docker.chmod(0o755)
    log = tmp_path / 'calls.jsonl'
    script = Path(__file__).resolve().parents[3] / 'build.sh'

    def run(*args, fail=''):
        result = subprocess.run(['bash', str(script), *args], cwd=tmp_path,
                                env={**os.environ, 'PATH': f'{tmp_path}:{os.environ["PATH"]}',
                                     'DOCKER_CALLS': str(log), 'DOCKER_FAIL': fail},
                                capture_output=True, text=True)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        return result, calls

    return run


def test_local_build_loads_image(build):
    result, calls = build('-t', 'face:test', '-l')
    assert result.returncode == 0
    command = next(c for c in calls if c[:2] == ['buildx', 'build'])
    assert '--load' in command
    assert not any(c[:2] == ['buildx', 'create'] for c in calls)


def test_build_arguments_are_not_executed_as_shell_code(build, tmp_path):
    marker = tmp_path / 'injected'
    tag = f'face:test; touch {marker}; #'
    result, calls = build('-t', tag, '-l')
    assert result.returncode == 0
    assert not marker.exists()
    command = next(c for c in calls if c[:2] == ['buildx', 'build'])
    assert command[command.index('-t') + 1] == tag


@pytest.mark.parametrize('failure', ['buildx create', 'run --rm'])
def test_setup_failure_stops_build(build, failure):
    result, calls = build('-t', 'face:test', '-p', fail=failure)
    assert result.returncode == 7
    assert not any(c[:2] == ['buildx', 'build'] for c in calls)
    if failure == 'run --rm':
        assert ['buildx', 'rm', 'test-builder'] in calls


def test_build_failure_preserves_exit_status_and_removes_builder(build):
    result, calls = build('-t', 'face:test', '-p', fail='buildx build')
    assert result.returncode == 7
    assert ['buildx', 'rm', 'test-builder'] in calls

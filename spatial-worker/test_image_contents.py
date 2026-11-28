"""The image runs only what the Dockerfile copies. The unit tests import modules
from the source tree, so a module missing from COPY passed CI and crashed the
container at boot (source_set.py, 0.8.9 rehearsal). This guards that gap."""
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def copied_modules():
    copied = set()
    for line in (HERE / 'Dockerfile').read_text(encoding='utf-8').splitlines():
        if line.startswith('COPY ') and line.rstrip().endswith('/worker/'):
            copied.update(item for item in line.split()[1:-1] if item.endswith('.py'))
    return copied


def local_imports(path):
    local = {p.stem for p in HERE.glob('*.py')}
    found = set()
    for match in re.finditer(r'^\s*(?:from\s+([a-z_][a-z0-9_]*)\s+import|import\s+([a-z_][a-z0-9_]*))',
                             path.read_text(encoding='utf-8'), re.MULTILINE):
        name = match.group(1) or match.group(2)
        if name in local:
            found.add(name + '.py')
    return found


class ImageContentsTest(unittest.TestCase):
    def test_every_module_the_server_loads_is_copied(self):
        copied = copied_modules()
        self.assertIn('server.py', copied)
        pending, seen = ['server.py'], set()
        while pending:
            module = pending.pop()
            if module in seen:
                continue
            seen.add(module)
            pending.extend(local_imports(HERE / module))
        missing = sorted(m for m in seen if m not in copied)
        self.assertEqual(missing, [], 'imported by the worker but not copied into the image: %s' % missing)

    def test_no_test_module_is_copied(self):
        self.assertEqual(sorted(m for m in copied_modules() if m.startswith('test_')), [])


if __name__ == '__main__':
    unittest.main()

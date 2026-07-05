# Shared pytest setup for the ProtoEmb test suite.
#
# Puts the generator (`core/`) and the testkit (this directory) on sys.path so
# `import generate` and `from protoemb_testkit import ...` work from any test
# module, regardless of where pytest is invoked from. Keeping this here makes the
# library self-testing once it is split out into its own repo.
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE = os.path.normpath(os.path.join(_HERE, "..", "core"))

for _p in (_HERE, _CORE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

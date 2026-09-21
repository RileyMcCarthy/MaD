# ONE insn.decode, TWO dispatchers. The hub-exec translator emits TCG through
# trans_*; the cog-exec interpreter executes through iexec_*. Generating both
# from the same table is what keeps them from disagreeing about an encoding --
# the same reason the table itself is generated from p2core's.
gen = [
  decodetree.process('insn.decode', extra_args: [ '--static-decode', 'decode_p2',
                                                  '--insnwidth', '32' ])
]

decode_interp = custom_target('decode-interp.c.inc',
  output: 'decode-interp.c.inc',
  input: 'insn.decode',
  command: [find_program(meson.project_source_root() / 'scripts' / 'decodetree.py'),
            '@INPUT@', '--static-decode', 'interp_p2', '--translate', 'iexec',
            '--insnwidth', '32', '-o', '@OUTPUT@'])

p2_ss = ss.source_set()
p2_system_ss = ss.source_set()

p2_ss.add(gen)
p2_ss.add(decode_interp)
p2_ss.add(files('translate.c', 'op_helper.c', 'cpu.c', 'pinbus.c', 'interp.c'))
p2_system_ss.add(files('machine.c'))

target_arch += {'p2': p2_ss}
target_system_arch += {'p2': p2_system_ss}

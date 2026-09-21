gen = [
  decodetree.process('insn.decode', extra_args: [ '--static-decode', 'decode_p2',
                                                  '--insnwidth', '32' ])
]

p2_ss = ss.source_set()
p2_system_ss = ss.source_set()

p2_ss.add(gen)
p2_ss.add(files('translate.c', 'op_helper.c', 'cpu.c', 'pinbus.c'))
p2_system_ss.add(files('machine.c'))

target_arch += {'p2': p2_ss}
target_system_arch += {'p2': p2_system_ss}

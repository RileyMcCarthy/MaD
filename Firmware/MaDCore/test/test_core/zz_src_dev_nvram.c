/* Compiles the module-under-test into this suite (build_src_filter only
 * builds Library/; every other src module is pulled into the suite that
 * exercises it so different suites can mock the same peer without clashing). */
#include "../../src/DEV/dev_nvram.c"

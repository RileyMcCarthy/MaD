//! A FAT16 card image the firmware's own filesystem can mount.
//!
//! The native backend never needs this: it substitutes the HAL, so `fopen`
//! lands on the host's filesystem and there is no card. The ISS executes the
//! real image, which means the real `mount(SD_CARD_MOUNT_PATH,
//! _vfs_open_sdcard())` runs FlexC's FatFs against a real block device — and
//! against a blank one it fails, which is why the ISS boots on failsafe
//! records. This builds a device it can actually mount.
//!
//! # What the firmware's FatFs accepts
//!
//! Read out of the toolchain's own `ffconf.h`
//! (`toolchain-flexcc/include/filesys/fatfs/ffconf.h`), not assumed:
//!
//! | knob | value | consequence |
//! |---|---|---|
//! | `FF_MIN_SS` / `FF_MAX_SS` | 512 / 512 | sectors are exactly 512 bytes |
//! | `FF_FS_EXFAT` | 0 | FAT12/16/32 only |
//! | `FF_USE_LFN` | 0 | **8.3 short names only** |
//! | `FF_USE_MKFS` | 0 | it cannot format; the image must arrive formatted |
//! | `FF_MULTI_PARTITION` | 0 | one volume |
//!
//! FAT16 is the middle child that avoids both awkward ends: no FAT12
//! twelve-bit packing, no FAT32 `FSInfo` bookkeeping. The image is a
//! *superfloppy* — a boot sector at LBA 0 with no MBR — which FatFs accepts
//! directly, because `check_fs` looks for a FAT VBR before it looks for a
//! partition table.
//!
//! # What the firmware needs on the card
//!
//! From `dev_nvram_config.c` and `IO_SDCard_config.c`:
//!
//! - `/profile.bin` — the machine profile record
//! - `/test/` — sample data, written as `<name>.bin`
//! - `/gcode/` — motion profiles, likewise
//!
//! The last two must exist as directories: the firmware opens files inside
//! them and does not create the parent.

use std::collections::BTreeMap;
use std::path::Path;

/// Bytes per sector. Not a choice — `FF_MIN_SS == FF_MAX_SS == 512`.
const SECTOR: usize = 512;
/// Sectors per cluster. 4 gives 2 KiB clusters, which keeps a 32 MiB card
/// comfortably inside FAT16's cluster-count window (see [`FAT16_MIN_CLUSTERS`]).
const SECTORS_PER_CLUSTER: usize = 4;
/// Reserved sectors before the first FAT. One is the boot sector itself.
const RESERVED_SECTORS: usize = 1;
/// Two FATs, as every real card has: FatFs reads the first and the second is
/// the mirror a recovery tool would use.
const NUM_FATS: usize = 2;
/// Root directory entries. FAT16's root is a fixed-size area, not a cluster
/// chain; 512 entries is the conventional size and 32 sectors of it.
const ROOT_ENTRIES: usize = 512;
/// One directory entry is 32 bytes.
const DIR_ENTRY: usize = 32;

/// Below this cluster count a volume is FAT12, whatever the boot sector says —
/// the type is *derived* from the count, so an image that lands under it would
/// be misread however it labels itself.
const FAT16_MIN_CLUSTERS: usize = 4085;
/// And above this it is FAT32, for the same reason.
const FAT16_MAX_CLUSTERS: usize = 65524;

/// First cluster number that addresses data. 0 and 1 are reserved.
const FIRST_DATA_CLUSTER: u16 = 2;

const ATTR_DIRECTORY: u8 = 0x10;

/// A directory being built, before it is laid out on the card.
#[derive(Debug, Default)]
pub struct Dir {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeMap<String, Dir>,
}

impl Dir {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a file. `name` is converted to 8.3 and must fit.
    pub fn file(&mut self, name: &str, contents: Vec<u8>) -> &mut Self {
        self.files.insert(name.to_string(), contents);
        self
    }

    /// Add (or reach into) a subdirectory.
    pub fn dir(&mut self, name: &str) -> &mut Dir {
        self.dirs.entry(name.to_string()).or_default()
    }

    /// Mirror a host directory onto the card.
    ///
    /// Deliberately shallow about errors: a missing source directory yields an
    /// empty one rather than failing, because the SD fixture is optional and a
    /// card with the right *shape* is what the firmware needs to mount.
    pub fn from_host_dir(path: &Path) -> Self {
        let mut out = Dir::new();
        let Ok(entries) = std::fs::read_dir(path) else {
            return out;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    *out.dirs.entry(name).or_default() = Dir::from_host_dir(&entry.path());
                }
                Ok(t) if t.is_file() => {
                    if let Ok(bytes) = std::fs::read(entry.path()) {
                        out.files.insert(name, bytes);
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// Why an image could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    /// The requested size lands outside FAT16's cluster-count window, where
    /// the volume would be read as FAT12 or FAT32 regardless of its label.
    NotFat16 {
        /// Data clusters the geometry produced.
        clusters: usize,
    },
    /// A name does not fit 8.3, and this FatFs has long names disabled.
    BadName {
        /// The offending name.
        name: String,
    },
    /// The contents do not fit in the card.
    Full {
        /// Clusters the contents need.
        needed: usize,
        /// Clusters the card has.
        available: usize,
    },
    /// A directory holds more entries than its area can list.
    DirFull {
        /// Which directory.
        name: String,
    },
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImageError::NotFat16 { clusters } => write!(
                f,
                "{clusters} data clusters is outside FAT16's window \
                 ({FAT16_MIN_CLUSTERS}..={FAT16_MAX_CLUSTERS}); pick another card size"
            ),
            ImageError::BadName { name } => {
                write!(
                    f,
                    "{name:?} does not fit 8.3 and this FatFs has FF_USE_LFN=0"
                )
            }
            ImageError::Full { needed, available } => {
                write!(
                    f,
                    "contents need {needed} clusters; the card has {available}"
                )
            }
            ImageError::DirFull { name } => write!(f, "directory {name:?} has too many entries"),
        }
    }
}

impl std::error::Error for ImageError {}

/// Convert to a FAT 8.3 name: eight bytes of stem, three of extension, space
/// padded, upper case.
fn short_name(name: &str) -> Result<[u8; 11], ImageError> {
    let bad = || ImageError::BadName {
        name: name.to_string(),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, e),
        None => (name, ""),
    };
    if stem.is_empty() || stem.len() > 8 || ext.len() > 3 {
        return Err(bad());
    }
    let mut out = [b' '; 11];
    for (i, c) in stem.bytes().enumerate() {
        if !c.is_ascii_alphanumeric() && !b"_-~".contains(&c) {
            return Err(bad());
        }
        out[i] = c.to_ascii_uppercase();
    }
    for (i, c) in ext.bytes().enumerate() {
        if !c.is_ascii_alphanumeric() {
            return Err(bad());
        }
        out[8 + i] = c.to_ascii_uppercase();
    }
    Ok(out)
}

/// A FAT16 volume under construction.
struct Layout {
    bytes: Vec<u8>,
    fat: Vec<u16>,
    sectors_per_fat: usize,
    data_start: usize,
    total_clusters: usize,
    next_free: u16,
}

impl Layout {
    fn cluster_bytes(&self) -> usize {
        SECTORS_PER_CLUSTER * SECTOR
    }

    fn cluster_offset(&self, cluster: u16) -> usize {
        self.data_start + (cluster as usize - FIRST_DATA_CLUSTER as usize) * self.cluster_bytes()
    }

    /// Allocate a chain long enough for `len` bytes, returning its first
    /// cluster (0 for an empty file — FAT's convention for "no data").
    fn alloc(&mut self, len: usize) -> Result<u16, ImageError> {
        if len == 0 {
            return Ok(0);
        }
        let need = len.div_ceil(self.cluster_bytes());
        let first = self.next_free;
        for i in 0..need {
            let c = self.next_free;
            if (c as usize) >= FIRST_DATA_CLUSTER as usize + self.total_clusters {
                return Err(ImageError::Full {
                    needed: need,
                    available: self.total_clusters,
                });
            }
            self.next_free += 1;
            // 0xFFFF ends the chain; otherwise point at the next.
            self.fat[c as usize] = if i + 1 == need {
                0xFFFF
            } else {
                self.next_free
            };
        }
        Ok(first)
    }

    fn write_chain(&mut self, first: u16, data: &[u8]) {
        let mut cluster = first;
        let size = self.cluster_bytes();
        for chunk in data.chunks(size) {
            let at = self.cluster_offset(cluster);
            self.bytes[at..at + chunk.len()].copy_from_slice(chunk);
            cluster = self.fat[cluster as usize];
        }
    }
}

/// One 32-byte directory entry.
fn dir_entry(name: [u8; 11], attr: u8, cluster: u16, size: u32) -> [u8; DIR_ENTRY] {
    let mut e = [0u8; DIR_ENTRY];
    e[0..11].copy_from_slice(&name);
    e[11] = attr;
    // A fixed timestamp, not the wall clock: an image built twice from the
    // same tree must be byte-identical, or a golden trace of the boot would
    // depend on when it ran. 1980-01-01 00:00 is FAT's own epoch.
    e[22..24].copy_from_slice(&0u16.to_le_bytes()); // time
    e[24..26].copy_from_slice(&0x21u16.to_le_bytes()); // date: 1980-01-01
    e[26..28].copy_from_slice(&cluster.to_le_bytes());
    e[28..32].copy_from_slice(&size.to_le_bytes());
    e
}

/// Lay a directory's contents out, returning its packed entry table.
///
/// Recursive: a subdirectory's own cluster is allocated here, filled with its
/// `.`/`..` pair and its children, and written before returning.
fn build_dir(
    layout: &mut Layout,
    dir: &Dir,
    self_cluster: u16,
    parent_cluster: u16,
    is_root: bool,
) -> Result<Vec<u8>, ImageError> {
    let mut entries: Vec<u8> = Vec::new();

    if !is_root {
        // Every non-root directory opens with `.` and `..`. FatFs walks these
        // to resolve a path, so a directory without them is unreachable.
        let mut dot = [b' '; 11];
        dot[0] = b'.';
        entries.extend_from_slice(&dir_entry(dot, ATTR_DIRECTORY, self_cluster, 0));
        let mut dotdot = [b' '; 11];
        dotdot[0] = b'.';
        dotdot[1] = b'.';
        // The root is cluster 0 from a child's point of view.
        entries.extend_from_slice(&dir_entry(dotdot, ATTR_DIRECTORY, parent_cluster, 0));
    }

    for (name, contents) in &dir.files {
        let first = layout.alloc(contents.len())?;
        if first != 0 {
            layout.write_chain(first, contents);
        }
        entries.extend_from_slice(&dir_entry(
            short_name(name)?,
            0x20, // archive
            first,
            contents.len() as u32,
        ));
    }

    for (name, sub) in &dir.dirs {
        // A directory always occupies at least one cluster, even when empty:
        // it has to hold `.` and `..`.
        let cluster = layout.alloc(1)?;
        let sub_entries = build_dir(layout, sub, cluster, self_cluster, false)?;
        if sub_entries.len() > layout.cluster_bytes() {
            return Err(ImageError::DirFull { name: name.clone() });
        }
        layout.write_chain(cluster, &sub_entries);
        entries.extend_from_slice(&dir_entry(short_name(name)?, ATTR_DIRECTORY, cluster, 0));
    }

    Ok(entries)
}

/// Build a FAT16 image of `size_bytes` holding `root`.
///
/// The result is a raw block device: hand it to
/// [`p2core::SdCard::with_image`].
pub fn build(size_bytes: usize, root: &Dir) -> Result<Vec<u8>, ImageError> {
    let total_sectors = size_bytes / SECTOR;
    let root_dir_sectors = ROOT_ENTRIES * DIR_ENTRY / SECTOR;

    // Sectors per FAT has to be solved for, because the FAT sizes itself to
    // the cluster count and the cluster count depends on how much the FATs
    // take. Converge rather than approximate: at 2 KiB clusters this settles
    // in two or three rounds.
    let mut sectors_per_fat = 1usize;
    let mut clusters;
    loop {
        let overhead = RESERVED_SECTORS + NUM_FATS * sectors_per_fat + root_dir_sectors;
        clusters = total_sectors.saturating_sub(overhead) / SECTORS_PER_CLUSTER;
        // Two bytes per FAT16 entry, plus the two reserved entries.
        let need = ((clusters + 2) * 2).div_ceil(SECTOR);
        if need <= sectors_per_fat {
            break;
        }
        sectors_per_fat = need;
    }

    if !(FAT16_MIN_CLUSTERS..=FAT16_MAX_CLUSTERS).contains(&clusters) {
        return Err(ImageError::NotFat16 { clusters });
    }

    let fat_start = RESERVED_SECTORS;
    let root_start = fat_start + NUM_FATS * sectors_per_fat;
    let data_start = (root_start + root_dir_sectors) * SECTOR;

    let mut layout = Layout {
        bytes: vec![0u8; total_sectors * SECTOR],
        fat: vec![0u16; clusters + FIRST_DATA_CLUSTER as usize],
        sectors_per_fat,
        data_start,
        total_clusters: clusters,
        next_free: FIRST_DATA_CLUSTER,
    };
    // The two reserved FAT entries: media byte, then an end-of-chain marker.
    layout.fat[0] = 0xFFF8;
    layout.fat[1] = 0xFFFF;

    let root_entries = build_dir(&mut layout, root, 0, 0, true)?;
    if root_entries.len() > ROOT_ENTRIES * DIR_ENTRY {
        return Err(ImageError::DirFull {
            name: "/".to_string(),
        });
    }

    // -- boot sector ---------------------------------------------------
    let bs = &mut layout.bytes[0..SECTOR];
    bs[0..3].copy_from_slice(&[0xEB, 0x3C, 0x90]); // jmp short + nop
    bs[3..11].copy_from_slice(b"MSWIN4.1"); // OEM name FatFs is happy with
    bs[11..13].copy_from_slice(&(SECTOR as u16).to_le_bytes());
    bs[13] = SECTORS_PER_CLUSTER as u8;
    bs[14..16].copy_from_slice(&(RESERVED_SECTORS as u16).to_le_bytes());
    bs[16] = NUM_FATS as u8;
    bs[17..19].copy_from_slice(&(ROOT_ENTRIES as u16).to_le_bytes());
    if total_sectors < 0x1_0000 {
        bs[19..21].copy_from_slice(&(total_sectors as u16).to_le_bytes());
    } else {
        bs[32..36].copy_from_slice(&(total_sectors as u32).to_le_bytes());
    }
    bs[21] = 0xF8; // fixed disk
    bs[22..24].copy_from_slice(&(sectors_per_fat as u16).to_le_bytes());
    bs[24..26].copy_from_slice(&63u16.to_le_bytes()); // sectors per track
    bs[26..28].copy_from_slice(&255u16.to_le_bytes()); // heads
    bs[36] = 0x80; // drive number
    bs[38] = 0x29; // extended boot signature: the three fields below are valid
    bs[39..43].copy_from_slice(&0x1234_5678u32.to_le_bytes()); // volume serial
    bs[43..54].copy_from_slice(b"MAD SIL    ");
    bs[54..62].copy_from_slice(b"FAT16   ");
    bs[510] = 0x55;
    bs[511] = 0xAA;

    // -- the FATs, mirrored --------------------------------------------
    let fat_bytes: Vec<u8> = layout.fat.iter().flat_map(|e| e.to_le_bytes()).collect();
    for copy in 0..NUM_FATS {
        let at = (fat_start + copy * layout.sectors_per_fat) * SECTOR;
        layout.bytes[at..at + fat_bytes.len()].copy_from_slice(&fat_bytes);
    }

    // -- root directory -------------------------------------------------
    let at = root_start * SECTOR;
    layout.bytes[at..at + root_entries.len()].copy_from_slice(&root_entries);

    Ok(layout.bytes)
}

/// The card the MaD firmware expects: a profile record and the two directories
/// it writes into.
///
/// `host_dir`, when it exists, is mirrored on top — so `SIL/sd` populates the
/// card exactly as it does for the native backend.
pub fn mad_card(size_bytes: usize, host_dir: Option<&Path>) -> Result<Vec<u8>, ImageError> {
    let mut root = host_dir.map(Dir::from_host_dir).unwrap_or_default();
    // The firmware opens files *inside* these and does not create the parent,
    // so a card without them mounts and then fails on first use.
    root.dir("test");
    root.dir("gcode");
    build(size_bytes, &root)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 32 MiB at 2 KiB clusters lands mid-window, not near either edge where a
    /// small geometry change would silently reclassify the volume.
    #[test]
    fn a_32mib_card_is_unambiguously_fat16() {
        let img = build(32 * 1024 * 1024, &Dir::new()).expect("builds");
        assert_eq!(img.len(), 32 * 1024 * 1024);
        assert_eq!(&img[54..62], b"FAT16   ");
        assert_eq!(img[510], 0x55);
        assert_eq!(img[511], 0xAA);
        assert_eq!(u16::from_le_bytes([img[11], img[12]]), 512, "sector size");
    }

    #[test]
    fn a_size_outside_the_window_is_refused_rather_than_mislabelled() {
        // 1 MiB at 2 KiB clusters is ~500 clusters: FAT12 territory. Labelling
        // it FAT16 would produce an image every driver reads differently.
        let err = build(1024 * 1024, &Dir::new()).expect_err("must refuse");
        assert!(matches!(err, ImageError::NotFat16 { .. }), "got {err:?}");
    }

    #[test]
    fn names_convert_to_8_3_and_bad_ones_are_refused() {
        assert_eq!(&short_name("profile.bin").unwrap(), b"PROFILE BIN");
        assert_eq!(&short_name("test").unwrap(), b"TEST       ");
        assert!(short_name("a-name-far-too-long.bin").is_err());
        assert!(short_name("name.long").is_err());
    }

    /// The directories the firmware writes into must exist, and each must open
    /// with `.` and `..` or FatFs cannot walk into it.
    #[test]
    fn the_mad_card_has_the_directories_the_firmware_opens_into() {
        let img = mad_card(32 * 1024 * 1024, None).expect("builds");
        let root_start = find_root_offset(&img);
        let names: Vec<String> = img[root_start..root_start + 512 * 32]
            .chunks(32)
            .take_while(|e| e[0] != 0)
            .map(|e| String::from_utf8_lossy(&e[0..11]).to_string())
            .collect();
        assert!(names.iter().any(|n| n == "TEST       "), "got {names:?}");
        assert!(names.iter().any(|n| n == "GCODE      "), "got {names:?}");

        // Walk into TEST and check its dot entries.
        let entry = img[root_start..]
            .chunks(32)
            .find(|e| &e[0..11] == b"TEST       ")
            .expect("TEST entry");
        let cluster = u16::from_le_bytes([entry[26], entry[27]]);
        assert!(cluster >= 2, "a directory owns a cluster");
        let at = data_offset(&img, cluster);
        assert_eq!(&img[at..at + 11], b".          ");
        assert_eq!(&img[at + 32..at + 43], b"..         ");
    }

    #[test]
    fn a_file_round_trips_through_its_cluster_chain() {
        // Larger than one 2 KiB cluster, so the chain has to be followed.
        let payload: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let mut root = Dir::new();
        root.file("profile.bin", payload.clone());
        let img = build(32 * 1024 * 1024, &root).expect("builds");

        let root_start = find_root_offset(&img);
        let entry = img[root_start..]
            .chunks(32)
            .find(|e| &e[0..11] == b"PROFILE BIN")
            .expect("PROFILE.BIN entry");
        assert_eq!(
            u32::from_le_bytes([entry[28], entry[29], entry[30], entry[31]]),
            payload.len() as u32
        );

        let mut cluster = u16::from_le_bytes([entry[26], entry[27]]);
        let mut got = Vec::new();
        while (FIRST_DATA_CLUSTER..0xFFF8).contains(&cluster) {
            let at = data_offset(&img, cluster);
            got.extend_from_slice(&img[at..at + 4 * 512]);
            cluster = fat_entry(&img, cluster);
        }
        got.truncate(payload.len());
        assert_eq!(got, payload, "the chain must reassemble the file");
    }

    /// Two builds of the same tree are byte-identical — no wall-clock
    /// timestamps, so a golden boot trace cannot depend on when it ran.
    #[test]
    fn the_image_is_reproducible() {
        let mut root = Dir::new();
        root.file("profile.bin", vec![1, 2, 3]);
        root.dir("gcode").file("a.bin", vec![4, 5]);
        let a = build(32 * 1024 * 1024, &root).expect("builds");
        let b = build(32 * 1024 * 1024, &root).expect("builds");
        assert_eq!(a, b);
    }

    // -- helpers that read the image back the way a driver would ---------

    fn bpb(img: &[u8]) -> (usize, usize, usize, usize) {
        let reserved = u16::from_le_bytes([img[14], img[15]]) as usize;
        let fats = img[16] as usize;
        let spf = u16::from_le_bytes([img[22], img[23]]) as usize;
        let root_entries = u16::from_le_bytes([img[17], img[18]]) as usize;
        (reserved, fats, spf, root_entries)
    }

    fn find_root_offset(img: &[u8]) -> usize {
        let (reserved, fats, spf, _) = bpb(img);
        (reserved + fats * spf) * SECTOR
    }

    fn data_offset(img: &[u8], cluster: u16) -> usize {
        let (reserved, fats, spf, root_entries) = bpb(img);
        let root_sectors = root_entries * DIR_ENTRY / SECTOR;
        let data_start = (reserved + fats * spf + root_sectors) * SECTOR;
        data_start + (cluster as usize - 2) * SECTORS_PER_CLUSTER * SECTOR
    }

    fn fat_entry(img: &[u8], cluster: u16) -> u16 {
        let (reserved, ..) = bpb(img);
        let at = reserved * SECTOR + cluster as usize * 2;
        u16::from_le_bytes([img[at], img[at + 1]])
    }
}

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Chip,
  Tooltip,
  Button,
  CircularProgress,
  LinearProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  Download as DownloadIcon,
  Visibility as ViewIcon,
  Delete as DeleteIcon,
  FileDownload as ExportIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import {
  FileDownloadProgress,
  TestRunEntry,
} from '@shared/SharedInterface';
import { useDevice } from '../hooks/useDevice';
import { componentLogger } from '../utils/logger';

type TestRunListEntry = Pick<
  TestRunEntry,
  'id' | 'testName' | 'sampleProfileId' | 'motionProfileId' | 'status' | 'startedAt' | 'completedAt'
> & {
  sampleProfileName?: string;
  motionProfileName?: string;
};

type TestRunListResponse = {
  runs: TestRunListEntry[];
  total: number;
  hasMore: boolean;
};

const PAGE_SIZE = 10;

export default function TestRuns() {
  const [, actions] = useDevice();
  const navigate = useNavigate();
  const [testRuns, setTestRuns] = useState<TestRunListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<FileDownloadProgress | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const loadTestRuns = useCallback(
    async ({ reset, offset }: { reset: boolean; offset: number }) => {
    try {
      if (reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      const response = (await window.electron.ipcRenderer.invoke(
        'data-get-test-runs',
        { offset, limit: PAGE_SIZE },
      )) as TestRunListResponse;

      const runs = response?.runs || [];
      setTestRuns((prev) => (reset ? runs : [...prev, ...runs]));
      setHasMore(Boolean(response?.hasMore));
    } catch (error) {
      componentLogger.error('Failed to load test runs:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
    },
    [],
  );

  useEffect(() => {
    loadTestRuns({ reset: true, offset: 0 });
  }, [loadTestRuns]);

  // Listen for download progress
  useEffect(() => {
    const cleanup = window.electron.ipcRenderer.on(
      'file-download-progress',
      (...args: unknown[]) => {
        const progress = args[0] as FileDownloadProgress;
        setDownloadProgress(progress);
        if (progress.status === 'complete' || progress.status === 'error') {
          setTimeout(() => {
            setDownloadingId(null);
            setDownloadProgress(null);
            loadTestRuns({ reset: true, offset: 0 }); // Refresh after download
          }, 1000);
        }
      },
    );
    return () => {
      cleanup?.();
    };
  }, [loadTestRuns]);

  const handleDownload = async (run: TestRunListEntry) => {
    try {
      setDownloadingId(run.id);

      // Get the test-runs directory
      const testRunsDir: string = await window.electron.ipcRenderer.invoke(
        'data-get-test-runs-dir',
      );

      // Download from firmware to a temporary path
      const savePath = `${testRunsDir}/${run.testName}.csv`;
      const result = await actions.downloadTestFile(run.testName, savePath);

      if (result.success && result.filePath) {
        // Update test run status — file already written by download handler
        await window.electron.ipcRenderer.invoke(
          'data-update-test-run',
          run.id,
          {
            status: 'downloaded',
            dataFilePath: `${run.testName}.csv`,
            completedAt: new Date().toISOString(),
          },
        );

        componentLogger.info(`Downloaded test data for ${run.testName}`);
        loadTestRuns({ reset: true, offset: 0 });
      } else {
        componentLogger.error(
          `Download failed for ${run.testName}: ${result.error}`,
        );
      }
    } catch (error) {
      componentLogger.error('Download error:', error);
    } finally {
      setDownloadingId(null);
      setDownloadProgress(null);
    }
  };

  const handleView = (run: TestRunListEntry) => {
    navigate(`/view/${run.id}`);
  };

  const handleExport = async (run: TestRunListEntry) => {
    try {
      // Use electron dialog to pick export path
      const testRunsDir: string = await window.electron.ipcRenderer.invoke(
        'data-get-test-runs-dir',
      );
      const exportPath = `${testRunsDir}/${run.testName}_export.csv`;
      const result = await window.electron.ipcRenderer.invoke(
        'data-export-test-csv',
        run.id,
        exportPath,
      );
      if (result.success) {
        componentLogger.info(`Exported to ${result.filePath}`);
      } else {
        componentLogger.error(`Export failed: ${result.error}`);
      }
    } catch (error) {
      componentLogger.error('Export error:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await window.electron.ipcRenderer.invoke('data-delete-test-run', id);
      setDeleteConfirmId(null);
      loadTestRuns({ reset: true, offset: 0 });
    } catch (error) {
      componentLogger.error('Delete error:', error);
    }
  };

  const getStatusChip = (status: TestRunListEntry['status']) => {
    const statusConfig: Record<
      string,
      { color: 'default' | 'primary' | 'success' | 'error' | 'warning'; label: string }
    > = {
      running: { color: 'primary', label: 'Running' },
      completed: { color: 'warning', label: 'Completed' },
      downloaded: { color: 'success', label: 'Downloaded' },
      error: { color: 'error', label: 'Error' },
    };
    const config = statusConfig[status] || {
      color: 'default' as const,
      label: status,
    };
    return <Chip size="small" color={config.color} label={config.label} />;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  };

  return (
    <Box sx={{ p: 3, height: 'calc(100vh - 64px)', overflow: 'auto' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Typography variant="h4">Test Runs</Typography>
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => loadTestRuns({ reset: true, offset: 0 })}
          variant="outlined"
        >
          Refresh
        </Button>
      </Box>

      {/* Download Progress Bar */}
      {downloadProgress && downloadProgress.status === 'downloading' && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="body2" gutterBottom>
            Downloading {downloadProgress.fileName}...
          </Typography>
          {downloadProgress.totalBytes > 0 ? (
            <LinearProgress
              variant="determinate"
              value={
                (downloadProgress.bytesDownloaded /
                  downloadProgress.totalBytes) *
                100
              }
            />
          ) : (
            <LinearProgress variant="indeterminate" />
          )}
          {downloadProgress.totalBytes > 0 ? (
            <Typography variant="caption" color="text.secondary">
              {Math.round(downloadProgress.bytesDownloaded / 1024)} /{' '}
              {Math.round(downloadProgress.totalBytes / 1024)} KB
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              {Math.round(downloadProgress.bytesDownloaded / 1024)} KB downloaded
            </Typography>
          )}
        </Paper>
      )}

      {loading ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: 300,
          }}
        >
          <CircularProgress />
        </Box>
      ) : testRuns.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" color="text.secondary">
            No test runs yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Go to Dashboard and run a test to see it here.
          </Typography>
        </Paper>
      ) : (
        <>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Test Name</TableCell>
                  <TableCell>Sample Profile</TableCell>
                  <TableCell>Motion Profile</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {testRuns.map((run) => (
                  <TableRow key={run.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight="bold">
                        {run.testName}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {run.sampleProfileName || run.sampleProfileId}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {run.motionProfileName || run.motionProfileId}
                      </Typography>
                    </TableCell>
                    <TableCell>{getStatusChip(run.status)}</TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {formatDate(run.startedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {/* Download button — only if not yet downloaded */}
                      {run.status !== 'downloaded' && (
                        <Tooltip title="Download data from device">
                          <span>
                            <IconButton
                              aria-label="Download test data"
                              onClick={() => handleDownload(run)}
                              disabled={downloadingId === run.id}
                              color="primary"
                            >
                              {downloadingId === run.id ? (
                                <CircularProgress size={20} />
                              ) : (
                                <DownloadIcon />
                              )}
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}

                      {/* View button — only if data is downloaded */}
                      {run.status === 'downloaded' && (
                        <>
                          <Tooltip title="View test data">
                            <IconButton
                              aria-label="View test data"
                              onClick={() => handleView(run)}
                              color="primary"
                            >
                              <ViewIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Export CSV with metadata">
                            <IconButton
                              aria-label="Export test data"
                              onClick={() => handleExport(run)}
                              color="secondary"
                            >
                              <ExportIcon />
                            </IconButton>
                          </Tooltip>
                        </>
                      )}

                      {/* Delete button */}
                      <Tooltip title="Delete test run">
                        <IconButton
                          aria-label="Delete test run"
                          onClick={() => setDeleteConfirmId(run.id)}
                          color="error"
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Button
                variant="outlined"
                onClick={() =>
                  loadTestRuns({ reset: false, offset: testRuns.length })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : `Load older runs (${PAGE_SIZE})`}
              </Button>
            </Box>
          )}
        </>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
      >
        <DialogTitle>Delete Test Run?</DialogTitle>
        <DialogContent>
          <Typography>
            This will permanently delete the test run and its data file. This
            action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
          <Button
            onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

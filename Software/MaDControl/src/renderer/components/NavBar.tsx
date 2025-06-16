import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { styled, useTheme, Theme, CSSObject } from '@mui/material/styles';
import { useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import MuiDrawer from '@mui/material/Drawer';
import MuiAppBar, { AppBarProps as MuiAppBarProps } from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import List from '@mui/material/List';
import CssBaseline from '@mui/material/CssBaseline';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuIcon from '@mui/icons-material/Menu';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import DashboardIcon from '@mui/icons-material/Dashboard';
import SettingsIcon from '@mui/icons-material/Settings';
import SourceIcon from '@mui/icons-material/Source';
import DeviceHubIcon from '@mui/icons-material/DeviceHub';
import LinkIcon from '@mui/icons-material/Link';
import CreateIcon from '@mui/icons-material/Create';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

const drawerWidth = 240;

const openedMixin = (theme: Theme): CSSObject => ({
  width: drawerWidth,
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.enteringScreen,
  }),
  overflowX: 'hidden',
});

const closedMixin = (theme: Theme): CSSObject => ({
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  overflowX: 'hidden',
  width: `calc(${theme.spacing(7)} + 1px)`,
  [theme.breakpoints.up('sm')]: {
    width: `calc(${theme.spacing(8)} + 1px)`,
  },
});

const DrawerHeader = styled('div')(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: theme.spacing(0, 1),
  // necessary for content to be below app bar
  ...theme.mixins.toolbar,
}));

interface AppBarProps extends MuiAppBarProps {
  open?: boolean;
}

const AppBar = styled(MuiAppBar, {
  shouldForwardProp: (prop) => prop !== 'open',
})<AppBarProps>(({ theme, open }) => ({
  zIndex: theme.zIndex.drawer + 1,
  transition: theme.transitions.create(['width', 'margin'], {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  ...(open && {
    marginLeft: drawerWidth,
    width: `calc(100% - ${drawerWidth}px)`,
    transition: theme.transitions.create(['width', 'margin'], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
  }),
}));

const Drawer = styled(MuiDrawer, {
  shouldForwardProp: (prop) => prop !== 'open',
})(({ theme, open }) => ({
  width: drawerWidth,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
  ...(open && {
    ...openedMixin(theme),
    '& .MuiDrawer-paper': openedMixin(theme),
  }),
  ...(!open && {
    ...closedMixin(theme),
    '& .MuiDrawer-paper': closedMixin(theme),
  }),
}));

type MiniDrawerProps = {
  children: React.ReactNode;
};

function SideBar({ children }: MiniDrawerProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false); // State to track connection status
  const [isDeviceResponding, setIsDeviceResponding] = useState(false); // State to track device responding status
  const location = useLocation();

  const pageNames = {
    '/dashboard': 'Dashboard',
    '/connect': 'Connect',
    '/create': 'Create',
    '/view': 'View',
    '/config': 'Machine Configuration',
    '/firmware': 'Firmware Update',
    // Add more paths and names as needed
  };
  const currentPageName = pageNames[location.pathname] || 'Dashboard';

  const handleDrawerOpen = () => {
    setOpen(true);
  };

  const handleDrawerClose = () => {
    setOpen(false);
  };

  // This will fetch and update device status every 2 seconds
  const checkConnection = async () => {
    try {
      // Check if a serial port is connected
      const connected = await window.electron.ipcRenderer.invoke('device-connected');

      // Check if device is responding
      const responding = await window.electron.ipcRenderer.invoke('device-responding');

      if (connected !== isConnected) {
        setIsConnected(connected);
      }

      if (responding !== isDeviceResponding) {
        setIsDeviceResponding(responding);
      }
    } catch (error) {
      console.error('Error checking connection status:', error);
    }
  };

  useEffect(() => {
    checkConnection(); // Fetch immediately on load

    const intervalId = setInterval(checkConnection, 2000); // Poll every 2 seconds

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  return (
    <Box sx={{ display: 'flex' }}>
      <CssBaseline />
      <AppBar position="fixed" open={open}>
        <Toolbar>
          <IconButton
            color="inherit"
            aria-label="open drawer"
            onClick={handleDrawerOpen}
            edge="start"
            sx={{
              marginRight: 5,
              ...(open && { display: 'none' }),
            }}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            {currentPageName}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {isConnected ? (
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <CheckCircleOutlineIcon
                  fontSize="small"
                  color="success"
                  sx={{ mr: 0.5 }}
                />
                Port Connected
                {isDeviceResponding ? (
                  <Box component="span" sx={{ ml: 1 }}>
                    <CheckCircleIcon
                      fontSize="small"
                      color="success"
                      sx={{ mr: 0.5 }}
                    />
                    Device Responding
                  </Box>
                ) : (
                  <Box component="span" sx={{ ml: 1 }}>
                    <ErrorOutlineIcon
                      fontSize="small"
                      color="warning"
                      sx={{ mr: 0.5 }}
                    />
                    Device Not Responding
                  </Box>
                )}
              </Box>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <ErrorOutlineIcon
                  fontSize="small"
                  color="error"
                  sx={{ mr: 0.5 }}
                />
                Not Connected
              </Box>
            )}
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" open={open}>
        <DrawerHeader>
          <IconButton onClick={handleDrawerClose}>
            {theme.direction === 'rtl' ? (
              <ChevronRightIcon />
            ) : (
              <ChevronLeftIcon />
            )}
          </IconButton>
        </DrawerHeader>
        <Divider />
        <List>
          {[
            { text: 'Dashboard', path: '/dashboard', icon: <DashboardIcon /> },
            { text: 'Tests', path: '/view', icon: <SourceIcon /> },
            { text: 'Create', path: '/create', icon: <CreateIcon /> },
            { text: 'Connect', path: '/connect', icon: <LinkIcon /> },
            {
              text: 'Device Configuration',
              path: '/config',
              icon: <DeviceHubIcon />,
            },
            { text: 'Firmware Update', path: '/firmware', icon: <SystemUpdateAltIcon /> },
            { text: 'Settings', path: '/drafts', icon: <SettingsIcon /> },
          ].map((item, index) => (
            <ListItem key={item.text} disablePadding sx={{ display: 'block' }}>
              <ListItemButton
                component={Link}
                to={item.path}
                sx={{
                  minHeight: 48,
                  justifyContent: open ? 'initial' : 'center',
                  px: 2.5,
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 0,
                    mr: open ? 3 : 'auto',
                    justifyContent: 'center',
                  }}
                >
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.text}
                  sx={{ opacity: open ? 1 : 0 }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
      <Box
        id="navbarMain"
        component="main"
        sx={{ flex: 1, marginTop: '64px' }}
      >
        {children}
      </Box>
    </Box>
  );
}

export default SideBar;

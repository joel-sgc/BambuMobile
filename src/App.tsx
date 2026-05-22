import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { load } from '@tauri-apps/plugin-store';
import type { PrinterConfig } from './vite-env';

import ConnectingScreen from './components/ConnectingScreen';
import SettingsPanel from './components/SettingsPanel';
import PrinterManager from './components/PrinterManager';
import Dashboard from './components/Dashboard';
import DebugPage from './components/DebugPage';
import FileManager from './components/FileManager';
import TimelapseBrowser from './components/TimelapseBrowser';
import Sidebar, { type Page } from './components/Sidebar';

type Phase = 'connecting' | 'connected' | 'error';

const STORE_FILE = 'bamboo-settings.json';

export default function App() {
  const [printers, setPrinters] = useState<PrinterConfig[]>([]);
  const [activePrinterId, setActivePrinterId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [connectError, setConnectError] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filePath, setFilePath] = useState('/');
  const [editingPrinter, setEditingPrinter] = useState<PrinterConfig | null>(
    null,
  );
  const [deviceName, setDeviceName] = useState('');
  const backActionRef = useRef<() => boolean>(() => false);
  const activePrinterIdRef = useRef<string | null>(null);

  const activePrinter = printers.find((p) => p.id === activePrinterId) ?? null;
  activePrinterIdRef.current = activePrinterId;

  async function persistPrinters(
    list: PrinterConfig[],
    activeId: string | null,
  ) {
    const store = await load(STORE_FILE, { autoSave: false, defaults: {} });
    await store.set('printers', list);
    await store.set('active_printer_id', activeId);
    await store.save();
  }

  async function connectTo(printer: PrinterConfig) {
    setPhase('connecting');
    setConnectError('');
    setDeviceName(printer.deviceName ?? '');
    try {
      await invoke('disconnect_printer').catch(() => {});
      await invoke('connect_printer', {
        ip: printer.ip,
        accessCode: printer.accessCode,
        serial: printer.serial,
      });
      setActivePrinterId(printer.id);
      setPhase('connected');
      setPage('dashboard');
    } catch (err) {
      if (String(err) === 'Already connected') {
        setActivePrinterId(printer.id);
        setPhase('connected');
        return;
      }
      setConnectError(String(err));
      setPhase('error');
    }
  }

  useEffect(() => {
    const unsub = listen<string>('printer-name', (e) => {
      const name = e.payload;
      setDeviceName(name);
      setPrinters((prev) => {
        const updated = prev.map((p) => {
          if (p.id !== activePrinterIdRef.current) return p;
          return { ...p, deviceName: name };
        });
        persistPrinters(updated, activePrinterIdRef.current);
        return updated;
      });
    });
    return () => { unsub.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: false, defaults: {} });
        let list = await store.get<PrinterConfig[]>('printers');
        let activeId = await store.get<string>('active_printer_id');

        // Migrate from old single-printer format
        if (!list || list.length === 0) {
          const oldIp = await store.get<string>('bambu_ip');
          const oldCode = await store.get<string>('bambu_code');
          const oldSerial = await store.get<string>('bambu_serial');
          if (oldIp && oldCode && oldSerial) {
            const migrated: PrinterConfig = {
              id: crypto.randomUUID(),
              nickname: 'My Printer',
              ip: oldIp,
              accessCode: oldCode,
              serial: oldSerial,
            };
            list = [migrated];
            activeId = migrated.id;
            await store.set('printers', list);
            await store.set('active_printer_id', activeId);
            await store.save();
          }
        }

        if (list && list.length > 0) {
          setPrinters(list);
          const target = list.find((p) => p.id === activeId) ?? list[0];
          await connectTo(target);
        } else {
          setPhase('error');
        }
      } catch {
        setPhase('error');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSavePrinter(config: Omit<PrinterConfig, 'id'>) {
    if (editingPrinter) {
      // Edit existing
      const updated = { ...editingPrinter, ...config };
      const newList = printers.map((p) => (p.id === updated.id ? updated : p));
      setPrinters(newList);
      setEditingPrinter(null);
      await persistPrinters(newList, activePrinterId);
      await connectTo(updated);
    } else {
      // Add new
      const newPrinter: PrinterConfig = { ...config, id: crypto.randomUUID() };
      const newList = [...printers, newPrinter];
      setPrinters(newList);
      await persistPrinters(newList, newPrinter.id);
      await connectTo(newPrinter);
    }
  }

  async function handleSwitch(printer: PrinterConfig) {
    const newList = printers; // list unchanged, just switching active
    await persistPrinters(newList, printer.id);
    await connectTo(printer);
  }

  async function handleDelete(id: string) {
    const newList = printers.filter((p) => p.id !== id);
    setPrinters(newList);

    let newActiveId = activePrinterId;
    if (id === activePrinterId) {
      newActiveId = newList[0]?.id ?? null;
    }
    await persistPrinters(newList, newActiveId);

    if (id === activePrinterId) {
      if (newList[0]) {
        await connectTo(newList[0]);
      } else {
        setPhase('error');
        setConnectError('');
      }
    }
  }

  function navigate(p: Page) {
    if (p === 'files') setFilePath('/');
    setPage(p);
    setSidebarOpen(false);
  }

  backActionRef.current = () => {
    if (sidebarOpen) {
      setSidebarOpen(false);
      return true;
    }
    if (page === 'printer-settings') {
      setEditingPrinter(null);
      navigate('printers');
      return true;
    }
    if (page === 'printers') {
      navigate('dashboard');
      return true;
    }
    if (page === 'files' && filePath !== '/') {
      const trimmed = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
      setFilePath(trimmed.substring(0, trimmed.lastIndexOf('/') + 1) || '/');
      return true;
    }
    if (page !== 'dashboard') {
      navigate('dashboard');
      return true;
    }
    return false;
  };

  useEffect(() => {
    const arm = () => window.history.pushState(null, '', window.location.pathname + '#step=' + Date.now());
    arm();
    const handle = () => {
      if (backActionRef.current()) arm();
    };
    window.addEventListener('popstate', handle);
    return () => window.removeEventListener('popstate', handle);
  }, []);

  if (phase === 'connecting')
    return <ConnectingScreen ip={activePrinter?.ip ?? ''} />;

  if (phase === 'error' && printers.length === 0) {
    return (
      <SettingsPanel
        isFirstSetup
        onSave={handleSavePrinter}
        error={connectError}
      />
    );
  }

  if (page === 'printer-settings') {
    return (
      <SettingsPanel
        initial={editingPrinter ?? undefined}
        onSave={handleSavePrinter}
        onBack={() => {
          setEditingPrinter(null);
          navigate('printers');
        }}
        error={connectError}
      />
    );
  }

  if (page === 'printers') {
    return (
      <PrinterManager
        printers={printers}
        activePrinterId={activePrinterId}
        onSwitch={handleSwitch}
        onEdit={(p) => {
          setEditingPrinter(p);
          navigate('printer-settings');
        }}
        onDelete={handleDelete}
        onAdd={() => {
          setEditingPrinter(null);
          navigate('printer-settings');
        }}
        onBack={() => navigate('dashboard')}
      />
    );
  }

  return (
    <>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        page={page}
        onNavigate={navigate}
        activePrinter={activePrinter}
        deviceName={deviceName}
      />

      {page === 'dashboard' && (
        <Dashboard
          onMenuOpen={() => setSidebarOpen(true)}
          serial={activePrinter?.serial}
        />
      )}

      {page === 'files' && (
        <FileManager
          onMenuOpen={() => setSidebarOpen(true)}
          path={filePath}
          onPathChange={setFilePath}
        />
      )}

      {page === 'timelapses' && (
        <TimelapseBrowser onMenuOpen={() => setSidebarOpen(true)} />
      )}

      {page === 'debug' && (
        <DebugPage onMenuOpen={() => setSidebarOpen(true)} />
      )}
    </>
  );
}

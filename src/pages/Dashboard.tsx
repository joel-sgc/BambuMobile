import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { hmsDescription } from '../utils/hmsErrors';
import PullToRefresh from 'react-simple-pull-to-refresh';
import { usePrinter } from '../context/PrinterContext';

import Section from '../components/Section';
import PrintStatusCard from '../components/PrintStatusCard';
import TempGauge from '../components/TempGauge';
import AmsView from '../components/AmsView';
import ExternalSpool, { VT_TRAY_ID } from '../components/ExternalSpool';
import SpeedGauge from '../components/SpeedGauge';
import JogControls from '../components/JogControls';
import ErrorPopup from '../components/ErrorPopup';

async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === 'granted';
  }
  if (granted) sendNotification({ title, body, largeBody: body });
}

export default function Dashboard({
  onMenuOpen,
  serial,
}: {
  onMenuOpen: () => void;
  serial?: string;
}) {
  // status and frameData come from the shared context — always populated even
  // after navigating away and back, so there's no loading flash on re-mount.
  const { status, frameData, refresh } = usePrinter();

  const [printPreview, setPrintPreview] = useState<string | null>(null);
  const [lightOn, setLightOn] = useState(false);
  const [speedLevel, setSpeedLevel] = useState(2);
  const [popupCodes, setPopupCodes] = useState<string[]>([]);
  const [selectedTrayId, setSelectedTrayId] = useState<number | null>(null);
  const [filamentBusy, setFilamentBusy] = useState(false);
  const lightPendingUntil = useRef(0);
  const speedPendingUntil = useRef(0);
  const previewJobRef = useRef('');
  const prevHmsRef = useRef<string[]>([]);
  const prevGcodeStateRef = useRef('');
  // Keep serial in a ref so the status effect closure always has the current value
  // without needing to be in the dependency array.
  const serialRef = useRef(serial);
  serialRef.current = serial;

  // React to every status update: sync light/speed UI and fire notifications.
  useEffect(() => {
    if (!status) return;
    const now = Date.now();
    if (now > lightPendingUntil.current) setLightOn(status.chamber_light);
    if (now > speedPendingUntil.current) setSpeedLevel(status.spd_lvl || 2);

    // Detect new HMS error codes
    const newCodes = (status.hms ?? []).filter(
      (c) => !prevHmsRef.current.includes(c),
    );
    if (newCodes.length > 0) {
      setPopupCodes(newCodes);
      const body = newCodes
        .map((c) => hmsDescription(c, serialRef.current))
        .join('\n');
      notify('Printer Alert', body);
    }
    prevHmsRef.current = status.hms ?? [];

    // Detect print completion
    const prev = prevGcodeStateRef.current;
    const next = status.gcode_state;
    if (prev === 'RUNNING' && next === 'FINISH') {
      const jobName = status.subtask_name || 'Your print';
      notify('Print Complete', `${jobName} has finished printing.`);
    }
    prevGcodeStateRef.current = next;
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch print preview whenever the active job changes.
  useEffect(() => {
    const name = status?.subtask_name ?? '';
    if (name === previewJobRef.current) return;
    previewJobRef.current = name;
    if (!name) {
      setPrintPreview(null);
      return;
    }
    invoke<string>('fetch_print_preview', {
      subtaskName: name,
      taskId: status?.task_id ?? '',
    })
      .then(setPrintPreview)
      .catch(() => setPrintPreview(null));
  }, [status?.subtask_name]);

  async function sendCommand(cmd: string) {
    await invoke('printer_command', { command: cmd }).catch(console.error);
  }

  async function sendGcode(gcode: string) {
    await invoke('send_gcode', { gcode }).catch(console.error);
  }

  async function toggleLight() {
    const next = !lightOn;
    setLightOn(next);
    lightPendingUntil.current = Date.now() + 5000;
    try {
      await invoke('set_chamber_light', { on: next });
    } catch {
      setLightOn(!next);
      lightPendingUntil.current = 0;
    }
  }

  async function setSpeed(level: number) {
    setSpeedLevel(level);
    speedPendingUntil.current = Date.now() + 5000;
    await invoke('set_print_speed', { level }).catch(console.error);
  }

  async function handleLoadFilament() {
    if (selectedTrayId === null) return;
    setFilamentBusy(true);
    try {
      await invoke('load_filament', { trayId: selectedTrayId });
    } catch (e) {
      console.error(e);
    } finally {
      setFilamentBusy(false);
    }
  }

  async function handleUnloadFilament() {
    setFilamentBusy(true);
    try {
      await invoke('unload_filament');
    } catch (e) {
      console.error(e);
    } finally {
      setFilamentBusy(false);
    }
  }

  const hasFilament =
    status && (status.ams.length > 0 || status.vt_tray != null);

  return (
    <div className='min-h-screen bg-zinc-950 text-white flex flex-col relative'>
      <div
        className='sticky top-0 z-10 flex items-center justify-between px-4 pb-3 bg-zinc-900 border-b border-zinc-800 shrink-0'
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button
          onClick={onMenuOpen}
          className='text-zinc-400 hover:text-white transition-colors'
          aria-label='Menu'>
          <svg
            className='w-6 h-6'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            strokeWidth={2}>
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              d='M4 6h16M4 12h16M4 18h16'
            />
          </svg>
        </button>
        <div className='flex flex-col items-center'>
          <h1 className='font-semibold text-lg'>BambooMobile</h1>
        </div>
      </div>

      <PullToRefresh
        onRefresh={refresh}
        className='flex-1 overflow-y-auto'>
        <div className='flex flex-col gap-3 p-4 pb-8'>
          {status && status.hms.length > 0 && (
            <div className='flex flex-col gap-2'>
              {status.hms.map((code) => (
                <div
                  key={code}
                  className='flex items-start gap-3 bg-red-950 border border-red-700 rounded-xl px-4 py-3'>
                  <svg
                    className='w-5 h-5 text-red-400 shrink-0 mt-0.5'
                    fill='none'
                    viewBox='0 0 24 24'
                    stroke='currentColor'
                    strokeWidth={2}>
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      d='M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z'
                    />
                  </svg>
                  <div className='flex flex-col gap-0.5 min-w-0'>
                    <p className='text-red-300 text-sm font-medium leading-snug'>
                      {hmsDescription(code, serial)}
                    </p>
                    <p className='text-red-600 text-xs font-mono'>{code}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className='rounded-xl overflow-hidden bg-zinc-900 aspect-video flex items-center justify-center shrink-0'>
            {frameData ?
              <img
                src={frameData}
                className='w-full h-full object-cover'
                alt='Live camera'
              />
            : <div className='flex flex-col items-center gap-2 text-center px-6'>
                <span className='text-3xl'>📷</span>
                <p className='text-zinc-400 text-sm font-medium'>
                  Connecting to camera…
                </p>
                <p className='text-zinc-600 text-xs'>
                  Waiting for stream on port 6000
                </p>
              </div>
            }
          </div>

          {status && (
            <PrintStatusCard
              status={status}
              printPreview={printPreview}
              onCommand={sendCommand}
              lightOn={lightOn}
              toggleLight={toggleLight}
            />
          )}

          <div className='flex flex-col bg-zinc-800 rounded-xl overflow-hidden'>
            {status && (
              <Section
                icon={
                  <div className='flex flex-col items-center justify-center gap-2'>
                    <div className='flex items-center justify-center p-3 bg-green-500 rounded-2xl'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        width='32'
                        height='32'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        stroke-width='2'
                        stroke-linecap='round'
                        stroke-linejoin='round'>
                        <path d='M5 6a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z' />
                        <path d='M15 7v6' />
                      </svg>
                    </div>
                    <span className='text-gray-300'>Printer</span>
                  </div>
                }>
                <div className='grid grid-cols-3 w-full gap-3'>
                  <TempGauge
                    icon={
                      <svg
                        width='32'
                        height='32'
                        viewBox='0 0 32 32'
                        fill='none'
                        xmlns='http://www.w3.org/2000/svg'>
                        <g clip-path='url(#clip0_4_2)'>
                          <path
                            d='M9 2V12M23 2V12M2.70711 12.2929L16.7071 26.2929M15.2931 26.2927L29.3017 12.2927M10 12H2M30 12H22M8 1H24'
                            stroke='currentColor'
                            stroke-width='2'
                          />
                          <path
                            d='M10.9639 22.9639C10.9868 23.1408 11 23.3194 11 23.5C11 24.6176 10.5494 25.6649 9.78125 26.625C9.21603 27.3315 9 27.9509 9 28.5C9 29.0491 9.21603 29.6685 9.78125 30.375C10.1263 30.8063 10.0563 31.4362 9.625 31.7812C9.19374 32.1263 8.56376 32.0563 8.21875 31.625C7.45064 30.6649 7 29.6176 7 28.5C7 27.3824 7.45064 26.3351 8.21875 25.375C8.78397 24.6685 9 24.0491 9 23.5C9 22.9509 8.78397 22.3315 8.21875 21.625C7.57453 20.8197 7.15417 19.9531 7.03516 19.0352L10.9639 22.9639Z'
                            fill='currentColor'
                          />
                          <path
                            d='M15.8916 27.8916L16 28.0332L16.0166 28.0166L16.0332 28.0332L16.0625 27.9932C16.0211 28.1687 16 28.3372 16 28.5C16 29.0491 16.216 29.6685 16.7812 30.375C17.1263 30.8063 17.0563 31.4362 16.625 31.7812C16.1937 32.1263 15.5638 32.0563 15.2188 31.625C14.4506 30.6649 14 29.6176 14 28.5C14 27.8025 14.1745 27.1318 14.4932 26.4932L15.8916 27.8916Z'
                            fill='currentColor'
                          />
                          <path
                            d='M23.7812 20.375C24.5494 21.3351 25 22.3824 25 23.5C25 24.6176 24.5494 25.6649 23.7812 26.625C23.216 27.3315 23 27.9509 23 28.5C23 29.0491 23.216 29.6685 23.7812 30.375C24.1263 30.8063 24.0563 31.4362 23.625 31.7812C23.1937 32.1263 22.5638 32.0563 22.2188 31.625C21.4506 30.6649 21 29.6176 21 28.5C21 27.3824 21.4506 26.3351 22.2188 25.375C22.784 24.6685 23 24.0491 23 23.5C23 22.9786 22.8035 22.3951 22.2998 21.7324L23.7275 20.3037C23.7456 20.327 23.7625 20.3515 23.7812 20.375Z'
                            fill='currentColor'
                          />
                        </g>
                        <defs>
                          <clipPath id='clip0_4_2'>
                            <rect width='32' height='32' fill='white' />
                          </clipPath>
                        </defs>
                      </svg>
                    }
                    actual={status.nozzle_temp}
                    target={status.nozzle_target}
                    max={300}
                    onSet={(t) => sendGcode(`M104 S${t}`)}
                  />
                  <TempGauge
                    icon={
                      <svg
                        width='32'
                        height='32'
                        viewBox='0 0 32 32'
                        fill='none'
                        xmlns='http://www.w3.org/2000/svg'>
                        <path
                          d='M16 1.00003C17.3333 2.6667 17.3333 4.33336 16 6.00003C14.6667 7.6667 14.6667 9.33336 16 11C17.3333 12.6667 17.3333 14.3334 16 16C14.6667 17.6667 14.6667 19.3334 16 21M23 1.00003C24.3333 2.6667 24.3333 4.33336 23 6.00003C21.6667 7.6667 21.6667 9.33336 23 11C24.3333 12.6667 24.3333 14.3334 23 16C21.6667 17.6667 21.6667 19.3334 23 21M9 1.00003C10.3333 2.6667 10.3333 4.33336 9 6.00003C7.66667 7.6667 7.66667 9.33336 9 11C10.3333 12.6667 10.3333 14.3334 9 16C7.66667 17.6667 7.66667 19.3334 9 21M3 31H29C30.1046 31 31 30.1046 31 29V27C31 25.8955 30.1046 25 29 25H3C1.89543 25 1 25.8955 1 27V29C1 30.1046 1.89543 31 3 31Z'
                          stroke='currentColor'
                          stroke-width='2'
                          stroke-linecap='round'
                          stroke-linejoin='round'
                        />
                      </svg>
                    }
                    actual={status.bed_temp}
                    target={status.bed_target}
                    max={120}
                    onSet={(t) => sendGcode(`M140 S${t}`)}
                  />
                  <SpeedGauge
                    level={speedLevel}
                    onSet={setSpeed}
                    icon={
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        width='32'
                        height='32'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'>
                        <path d='m12 14 4-4' />
                        <path d='M3.34 19a10 10 0 1 1 17.32 0' />
                      </svg>
                    }
                  />
                </div>
              </Section>
            )}

            {hasFilament && (
              <Section
                icon={
                  <div className='flex flex-col items-center justify-center gap-2'>
                    <div className='flex items-center justify-center p-3 bg-blue-500 rounded-2xl'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        width='32'
                        height='32'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        stroke-width='2'
                        stroke-linecap='round'
                        stroke-linejoin='round'>
                        <path d='M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0' />
                        <path d='M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6' />
                        <path d='M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6' />
                        <circle cx='12' cy='12' r='10' />
                      </svg>
                    </div>
                    <span className='text-gray-300'>AMS</span>
                  </div>
                }>
                <AmsView
                  ams={status!.ams}
                  selectedTrayId={selectedTrayId}
                  activeGlobalTrayId={status!.tray_now}
                  onSelectTray={(id) => setSelectedTrayId((prev) => prev === id ? null : id)}
                />
              </Section>
            )}

            {status?.vt_tray && (
              <Section
                icon={
                  <div className='flex flex-col items-center justify-center gap-2'>
                    <div className='flex items-center justify-center p-3 bg-purple-500 rounded-2xl'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        width='32'
                        height='32'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        stroke-width='2'
                        stroke-linecap='round'
                        stroke-linejoin='round'>
                        <path d='M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0' />
                        <path d='M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6' />
                        <path d='M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6' />
                        <circle cx='12' cy='12' r='10' />
                      </svg>
                    </div>
                    <span className='text-gray-300'>Ext. Fila.</span>
                  </div>
                }>
                <ExternalSpool
                  tray={status!.vt_tray}
                  selected={selectedTrayId === VT_TRAY_ID}
                  active={status!.tray_now === VT_TRAY_ID}
                  onSelect={() => setSelectedTrayId((prev) => prev === VT_TRAY_ID ? null : VT_TRAY_ID)}
                />
              </Section>
            )}
          </div>

          {/* Load / Unload filament controls */}
          {hasFilament && (
            <div className='flex gap-3'>
              <button
                onClick={handleUnloadFilament}
                disabled={filamentBusy}
                className='flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-sm font-medium rounded-xl py-3 transition-colors'>
                Unload
              </button>
              <button
                onClick={handleLoadFilament}
                disabled={filamentBusy || selectedTrayId === null}
                className='flex-1 bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white text-sm font-medium rounded-xl py-3 transition-colors'>
                {selectedTrayId === null ? 'Select a slot' : 'Load'}
              </button>
            </div>
          )}

          {status && (
            <div className='bg-zinc-800 rounded-xl overflow-hidden p-4'>
              {status.gcode_state === 'RUNNING' ?
                <p className='text-zinc-500 text-sm text-center py-4'>
                  Manual controls are disabled while printing.
                </p>
              : <JogControls onGcode={sendGcode} />}
            </div>
          )}

          {!status && (
            <p className='text-zinc-500 text-center py-8'>
              Waiting for printer data…
            </p>
          )}
        </div>
      </PullToRefresh>

      <ErrorPopup
        codes={popupCodes}
        serial={serial}
        onDismiss={() => setPopupCodes([])}
      />
    </div>
  );
}

import type { PrinterConfig } from '../vite-env';
import { serialToModel } from '../utils/hmsErrors';

export type Page = 'dashboard' | 'files' | 'timelapses' | 'printers' | 'printer-settings' | 'debug';

const NAV = [
  {
    page: 'dashboard' as Page,
    label: 'Dashboard',
    icon: (
      <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={1.75}>
        <rect x='3' y='3' width='7' height='7' rx='1' />
        <rect x='14' y='3' width='7' height='7' rx='1' />
        <rect x='3' y='14' width='7' height='7' rx='1' />
        <rect x='14' y='14' width='7' height='7' rx='1' />
      </svg>
    ),
  },
  {
    page: 'files' as Page,
    label: 'File Manager',
    icon: (
      <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={1.75}>
        <path strokeLinecap='round' strokeLinejoin='round' d='M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z' />
      </svg>
    ),
  },
  {
    page: 'timelapses' as Page,
    label: 'Timelapses',
    icon: (
      <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={1.75}>
        <path strokeLinecap='round' strokeLinejoin='round' d='M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' />
      </svg>
    ),
  },
  {
    page: 'printers' as Page,
    label: 'Printers',
    icon: (
      <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={1.75}>
        <path strokeLinecap='round' strokeLinejoin='round' d='M5 6a4 4 0 014-4h6a4 4 0 014 4v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6z' />
        <path strokeLinecap='round' strokeLinejoin='round' d='M15 7v6' />
      </svg>
    ),
  },
  {
    page: 'debug' as Page,
    label: 'MQTT Debug',
    icon: (
      <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={1.75}>
        <path strokeLinecap='round' strokeLinejoin='round' d='M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' />
      </svg>
    ),
  },
] as const;

export default function Sidebar({
  open,
  onClose,
  page,
  onNavigate,
  activePrinter,
  deviceName,
}: {
  open: boolean;
  onClose: () => void;
  page: Page;
  onNavigate: (p: Page) => void;
  activePrinter: PrinterConfig | null;
  deviceName?: string;
}) {
  const model = activePrinter ? serialToModel(activePrinter.serial) : null;
  const displayName = activePrinter
    ? activePrinter.nickname || deviceName || (model ? `My ${model}` : activePrinter.ip)
    : '';

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 z-40 transition-opacity duration-300 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      <div
        className={`fixed top-0 right-0 h-full w-64 bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col transform transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className='flex items-center justify-between px-5 py-4 border-b border-zinc-800'>
          <span className='text-white font-semibold'>BambooMobile</span>
          <button
            onClick={onClose}
            className='text-zinc-400 hover:text-white transition-colors w-8 h-8 flex items-center justify-center'>
            <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
              <path strokeLinecap='round' strokeLinejoin='round' d='M6 18L18 6M6 6l12 12' />
            </svg>
          </button>
        </div>

        {activePrinter && (
          <button
            onClick={() => onNavigate('printers')}
            className='flex items-center gap-3 mx-3 mt-3 px-3 py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors text-left'>
            <div className='w-2 h-2 rounded-full bg-teal-400 shrink-0' />
            <div className='flex flex-col min-w-0 flex-1'>
              <span className='text-white text-sm font-medium truncate'>{displayName}</span>
              <span className='text-zinc-500 text-xs font-mono truncate'>{activePrinter.ip}</span>
            </div>
            <svg className='w-4 h-4 text-zinc-500 shrink-0' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
              <path strokeLinecap='round' strokeLinejoin='round' d='M8 9l4-4 4 4m0 6l-4 4-4-4' />
            </svg>
          </button>
        )}

        <nav className='flex flex-col p-3 gap-1 flex-1 mt-1'>
          {NAV.map((item) => (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors ${
                page === item.page ?
                  'bg-teal-900/50 text-teal-400'
                : 'text-zinc-300 hover:bg-zinc-800'
              }`}>
              {item.icon}
              <span className='font-medium text-sm'>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}

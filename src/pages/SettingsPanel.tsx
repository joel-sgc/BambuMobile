import { useState } from 'react';
import type { PrinterConfig } from '../vite-env';

export default function SettingsPanel({
  initial,
  onSave,
  onBack,
  error,
  isFirstSetup = false,
}: {
  initial?: Partial<PrinterConfig>;
  onSave: (config: Omit<PrinterConfig, 'id'>) => void;
  onBack?: () => void;
  error?: string;
  isFirstSetup?: boolean;
}) {
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const [ip, setIp] = useState(initial?.ip ?? '');
  const [accessCode, setAccessCode] = useState(initial?.accessCode ?? '');
  const [serial, setSerial] = useState(initial?.serial ?? '');

  const isEdit = !!initial?.id;
  const title = isFirstSetup ? 'Add Your Printer' : isEdit ? 'Edit Printer' : 'Add Printer';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ nickname: nickname.trim(), ip, accessCode, serial });
  }

  return (
    <div className='min-h-screen bg-zinc-950 text-white flex flex-col'>
      <div
        className='flex items-center px-4 pb-3 bg-zinc-900 border-b border-zinc-800 gap-3'
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        {onBack && (
          <button
            onClick={onBack}
            className='text-zinc-400 hover:text-white transition-colors text-lg leading-none'>
            ←
          </button>
        )}
        <h1 className='font-semibold text-lg'>{title}</h1>
      </div>

      <div className='flex-1 p-6 flex flex-col gap-4'>
        {error && (
          <div className='bg-red-950/40 border border-red-800/50 rounded-xl px-4 py-3'>
            <p className='text-red-400 text-sm font-medium'>Connection failed</p>
            <p className='text-red-500/80 text-xs mt-1'>{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          <label className='flex flex-col gap-1'>
            <span className='text-zinc-400 text-xs uppercase tracking-wider'>Nickname</span>
            <input
              className='bg-zinc-800 text-white rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-teal-500'
              placeholder='e.g. Bambu X1 Carbon'
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>

          <label className='flex flex-col gap-1'>
            <span className='text-zinc-400 text-xs uppercase tracking-wider'>Printer IP</span>
            <input
              className='bg-zinc-800 text-white rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-teal-500'
              placeholder='192.168.1.100'
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              required
            />
          </label>

          <label className='flex flex-col gap-1'>
            <span className='text-zinc-400 text-xs uppercase tracking-wider'>Access Code</span>
            <input
              className='bg-zinc-800 text-white rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-teal-500 font-mono tracking-widest'
              placeholder='12345678'
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              required
            />
          </label>

          <label className='flex flex-col gap-1'>
            <span className='text-zinc-400 text-xs uppercase tracking-wider'>Serial Number</span>
            <input
              className='bg-zinc-800 text-white rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-teal-500 font-mono'
              placeholder='01P09C400101231'
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              required
            />
          </label>

          <button
            type='submit'
            className='bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg py-3 transition-colors mt-2'>
            {isEdit ? 'Save & Reconnect' : 'Connect'}
          </button>
        </form>

        <p className='text-zinc-600 text-xs text-center'>
          Find your access code on the printer touchscreen → Settings → WLAN
        </p>
      </div>
    </div>
  );
}

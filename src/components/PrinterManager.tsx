import type { PrinterConfig } from '../vite-env';
import { serialToModel } from '../utils/hmsErrors';

export default function PrinterManager({
  printers,
  activePrinterId,
  onSwitch,
  onEdit,
  onDelete,
  onAdd,
  onBack,
}: {
  printers: PrinterConfig[];
  activePrinterId: string | null;
  onSwitch: (printer: PrinterConfig) => void;
  onEdit: (printer: PrinterConfig) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onBack: () => void;
}) {
  return (
    <div className='min-h-screen bg-zinc-950 text-white flex flex-col'>
      <div
        className='flex items-center justify-between px-4 pb-3 bg-zinc-900 border-b border-zinc-800'
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <div className='flex items-center gap-3'>
          <button
            onClick={onBack}
            className='text-zinc-400 hover:text-white transition-colors text-lg leading-none'>
            ←
          </button>
          <h1 className='font-semibold text-lg'>Printers</h1>
        </div>
        <button
          onClick={onAdd}
          className='flex items-center gap-1.5 text-teal-400 hover:text-teal-300 transition-colors text-sm font-medium'>
          <svg className='w-4 h-4' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
            <path strokeLinecap='round' strokeLinejoin='round' d='M12 4v16m8-8H4' />
          </svg>
          Add
        </button>
      </div>

      <div className='flex-1 p-4 flex flex-col gap-3'>
        {printers.length === 0 && (
          <p className='text-zinc-500 text-center py-12'>No printers added yet.</p>
        )}

        {printers.map((printer) => {
          const isActive = printer.id === activePrinterId;
          const model = serialToModel(printer.serial);
          const displayName = printer.nickname || printer.deviceName || (model ? `My ${model}` : printer.ip);
          return (
            <div
              key={printer.id}
              className={`flex items-center gap-3 bg-zinc-800 rounded-xl px-4 py-3 border ${
                isActive ? 'border-teal-600' : 'border-transparent'
              }`}>
              <button
                className='flex-1 flex items-center gap-3 text-left'
                onClick={() => !isActive && onSwitch(printer)}>
                <div className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-teal-400' : 'bg-zinc-600'}`} />
                <div className='flex flex-col min-w-0'>
                  <span className={`font-medium text-sm truncate ${isActive ? 'text-teal-300' : 'text-white'}`}>
                    {displayName}
                  </span>
                  <span className='text-zinc-500 text-xs font-mono truncate'>{printer.ip}</span>
                </div>
                {isActive && (
                  <span className='text-teal-500 text-xs font-medium shrink-0 ml-auto mr-2'>Active</span>
                )}
              </button>

              <button
                onClick={() => onEdit(printer)}
                className='text-zinc-400 hover:text-white transition-colors p-1.5'>
                <svg className='w-4 h-4' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
                  <path strokeLinecap='round' strokeLinejoin='round' d='M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z' />
                </svg>
              </button>

              <button
                onClick={() => onDelete(printer.id)}
                className='text-zinc-400 hover:text-red-400 transition-colors p-1.5'>
                <svg className='w-4 h-4' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
                  <path strokeLinecap='round' strokeLinejoin='round' d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16' />
                </svg>
              </button>
            </div>
          );
        })}

        <button
          onClick={onAdd}
          className='flex items-center justify-center gap-2 border-2 border-dashed border-zinc-700 hover:border-teal-600 text-zinc-500 hover:text-teal-400 rounded-xl py-4 transition-colors mt-1'>
          <svg className='w-5 h-5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
            <path strokeLinecap='round' strokeLinejoin='round' d='M12 4v16m8-8H4' />
          </svg>
          <span className='text-sm font-medium'>Add Printer</span>
        </button>
      </div>
    </div>
  );
}

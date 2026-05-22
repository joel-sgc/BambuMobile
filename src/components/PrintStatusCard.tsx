import type { PrinterStatus } from '../vite-env';
import { fmtRemaining, gcodeLabel } from '../utils/printer';

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className='w-full bg-zinc-700 rounded-full h-2 col-span-2'>
      <div
        className='bg-green-300 h-2 rounded-full transition-all duration-500'
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

export default function PrintStatusCard({
  status,
  printPreview,
  onCommand,
  lightOn,
  toggleLight,
}: {
  status: PrinterStatus;
  printPreview: string | null;
  onCommand: (cmd: string) => void;
  lightOn: boolean;
  toggleLight: () => void;
}) {
  const { text: stateLabel, dot: stateDot } = gcodeLabel(status.gcode_state);
  const isPrinting = status.gcode_state === 'RUNNING';
  const isPaused = status.gcode_state === 'PAUSE';
  const isActive = isPrinting || isPaused;
  const isFinished = status.gcode_state === 'FINISH';
  const isFailed = status.gcode_state === 'FAILED';

  return (
    <div className='flex flex-col gap-4 p-4 bg-zinc-800 rounded-xl '>
      <div
        className={`grid ${printPreview ? 'grid-cols-[auto_1fr]' : ''} gap-4`}>
        {/* PREVIEW */}
        {(isActive || isFinished) && printPreview && status?.subtask_name && (
          <div className='size-32 overflow-clip flex items-center justify-center'>
            <img
              src={printPreview}
              className='size-[calc(100%+64px)] max-w-none'
              alt='Print preview'
            />
          </div>
        )}

        {/* INFO AND CONTROLS  */}
        <div className='flex flex-col gap-4'>
          {(isActive || isFinished) && status?.subtask_name && (
            <span className='my-auto opacity-75'>{status.subtask_name}</span>
          )}
          {isActive ?
            <div className='grid grid-cols-[auto_auto] justify-between gap-2 w-full'>
              <span className='w-full'>Printed Layers</span>
              <span className='text-end'>
                {status.layer_num}/{status.total_layer_num}
              </span>
              <span className='text-2xl font-bold text-green-300'>
                {status.progress}%
              </span>
              <span className='text-end'>
                {fmtRemaining(status.remaining_mins)}
              </span>
              <ProgressBar percent={status.progress} />
            </div>
          : <div className='flex items-center gap-3 -mb-4'>
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${stateDot}`}
              />
              <div className='flex flex-col'>
                <span className='text-white font-semibold'>{stateLabel}</span>
                {(isFinished || isFailed) && status.total_layer_num > 0 && (
                  <span className='text-zinc-400 text-sm'>
                    {status.layer_num} / {status.total_layer_num} layers
                  </span>
                )}
                {!isFinished &&
                  !isFailed &&
                  status.stage &&
                  status.stage !== 'Idle' && (
                    <span className='text-zinc-400 text-sm'>
                      {status.stage}
                    </span>
                  )}
              </div>
            </div>
          }
        </div>
      </div>
      <div className='grid grid-cols-[1fr_2px_1fr_2px_1fr] gap-2 pt-4 text-zinc-400 tracking-wide font-semibold'>
        <button
          onClick={toggleLight}
          className={`flex items-center justify-center gap-2 ${!isActive && 'col-span-5 border-t-2 border-zinc-500 pt-4'}`}>
          <span
            className={`leading-none mt-1 text-yellow-500 ${!lightOn && 'opacity-50'}`}>
            {lightOn ?
              <svg
                xmlns='http://www.w3.org/2000/svg'
                width='20'
                height='20'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                stroke-width='2'
                stroke-linecap='round'
                stroke-linejoin='round'>
                <path d='M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' />
                <path d='M9 18h6' />
                <path d='M10 22h4' />
              </svg>
            : <svg
                xmlns='http://www.w3.org/2000/svg'
                width='20'
                height='20'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                stroke-width='2'
                stroke-linecap='round'
                stroke-linejoin='round'>
                <path d='M16.8 11.2c.8-.9 1.2-2 1.2-3.2a6 6 0 0 0-9.3-5' />
                <path d='m2 2 20 20' />
                <path d='M6.3 6.3a4.67 4.67 0 0 0 1.2 5.2c.7.7 1.3 1.5 1.5 2.5' />
                <path d='M9 18h6' />
                <path d='M10 22h4' />
              </svg>
            }
          </span>
          <span className={lightOn ? 'text-white font-bold' : ''}>Light</span>
        </button>

        {isActive && (
          <>
            <div className='h-full w-0.5 bg-zinc-600' />

            <>
              {isPrinting && (
                <button
                  onClick={() => onCommand('pause')}
                  className='flex items-center justify-center gap-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='24'
                    height='24'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    stroke-width='2'
                    stroke-linecap='round'
                    stroke-linejoin='round'
                    className='text-orange-400'>
                    <rect x='14' y='3' width='5' height='18' rx='1' />
                    <rect x='5' y='3' width='5' height='18' rx='1' />
                  </svg>
                  Pause
                </button>
              )}
              {isPaused && (
                <button
                  onClick={() => onCommand('resume')}
                  className='flex items-center justify-center gap-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='24'
                    height='24'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    stroke-width='2'
                    stroke-linecap='round'
                    stroke-linejoin='round'
                    className='text-green-300'>
                    <path d='M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' />
                  </svg>
                  Resume
                </button>
              )}
            </>

            <div className='h-full w-0.5 bg-zinc-600' />

            <button
              onClick={() => onCommand('stop')}
              className='flex items-center justify-center gap-2'>
              <svg
                xmlns='http://www.w3.org/2000/svg'
                width='24'
                height='24'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                stroke-width='2'
                stroke-linecap='round'
                stroke-linejoin='round'
                className='text-red-500'>
                <path d='m15 9-6 6' />
                <path d='M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z' />
                <path d='m9 9 6 6' />
              </svg>
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

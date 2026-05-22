/// <reference types="vite/client" />

export interface PrinterConfig {
  id: string;
  nickname: string;
  ip: string;
  accessCode: string;
  serial: string;
  deviceName?: string;
}

export interface AmsTray {
  id: number;
  tray_type: string;
  color: string;
  name: string;
}

export interface AmsUnit {
  id: number;
  humidity: number;
  trays: AmsTray[];
}

export interface PrinterStatus {
  nozzle_temp: number;
  nozzle_target: number;
  bed_temp: number;
  bed_target: number;
  progress: number;
  remaining_mins: number;
  layer_num: number;
  total_layer_num: number;
  stage: string;
  gcode_state: string;
  ams: AmsUnit[];
  vt_tray: AmsTray | null;
  chamber_light: boolean;
  spd_lvl: number;
  subtask_name: string;
  task_id: string;
  hms: string[];
  device_name: string;
}

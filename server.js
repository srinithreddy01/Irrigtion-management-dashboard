const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const app = express();
const PORT = 3000;
const staticDir = path.join(__dirname, 'irrigation-dashboard');

app.use(express.json());
app.use(express.static(staticDir));

const AQUAFARM_SCHEMA_SQL = `-- ============================================================================
-- AquaFarm Database Schema for Supabase / PostgreSQL
-- ============================================================================

-- 1. General Application State (Settings, Schedules, Alerts, Pump)
CREATE TABLE IF NOT EXISTS aquafarm_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Timeseries Sensor Readings (Soil moisture, temperature, humidity, tank)
CREATE TABLE IF NOT EXISTS sensor_readings (
  id BIGSERIAL PRIMARY KEY,
  sensor_node TEXT NOT NULL DEFAULT 'AF-01',
  soil_moisture NUMERIC NOT NULL,
  temperature NUMERIC NOT NULL,
  humidity NUMERIC NOT NULL,
  tank_percent NUMERIC NOT NULL,
  water_used_today NUMERIC,
  wind_speed NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Irrigation Pump Execution Logs
CREATE TABLE IF NOT EXISTS pump_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,          -- 'START' or 'STOP'
  mode TEXT NOT NULL,            -- 'Manual', 'Automatic', 'Scheduled'
  field_id TEXT NOT NULL,        -- 'A', 'B', 'C'
  duration_minutes NUMERIC,
  water_litres NUMERIC,
  soil_moisture NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Alerts & Notifications
CREATE TABLE IF NOT EXISTS farm_alerts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Field Zones Configuration Table
CREATE TABLE IF NOT EXISTS farm_fields (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  crop TEXT NOT NULL,
  stage TEXT NOT NULL,
  area_acres NUMERIC NOT NULL,
  target_min NUMERIC NOT NULL,
  target_max NUMERIC NOT NULL,
  irrigation_method TEXT NOT NULL,
  sensor_node TEXT NOT NULL,
  status TEXT DEFAULT 'Active',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Irrigation Schedules Table
CREATE TABLE IF NOT EXISTS irrigation_schedules (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  scheduled_time TIME NOT NULL,
  duration_minutes INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT DEFAULT 'Pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) and public access
ALTER TABLE aquafarm_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pump_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE irrigation_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'aquafarm_state' AND policyname = 'Allow public read/write to aquafarm_state') THEN
    CREATE POLICY "Allow public read/write to aquafarm_state" ON aquafarm_state FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sensor_readings' AND policyname = 'Allow public read/write to sensor_readings') THEN
    CREATE POLICY "Allow public read/write to sensor_readings" ON sensor_readings FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pump_logs' AND policyname = 'Allow public read/write to pump_logs') THEN
    CREATE POLICY "Allow public read/write to pump_logs" ON pump_logs FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'farm_alerts' AND policyname = 'Allow public read/write to farm_alerts') THEN
    CREATE POLICY "Allow public read/write to farm_alerts" ON farm_alerts FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'farm_fields' AND policyname = 'Allow public read/write to farm_fields') THEN
    CREATE POLICY "Allow public read/write to farm_fields" ON farm_fields FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'irrigation_schedules' AND policyname = 'Allow public read/write to irrigation_schedules') THEN
    CREATE POLICY "Allow public read/write to irrigation_schedules" ON irrigation_schedules FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
`;

// In-memory / file fallback store
const LOCAL_STORE_FILE = path.join(__dirname, '.aquafarm_store.json');
let localStore = {
  settings: null,
  pump: null,
  schedules: [],
  alerts: [],
  activity: [],
  telemetryLogs: [
    { id: 1, node: "AF-01", soilMoisture: 42, temperature: 28, humidity: 64, tankPercent: 76, windSpeed: 12, status: "Optimal", timestamp: new Date(Date.now() - 300000).toLocaleTimeString() },
    { id: 2, node: "AF-02", soilMoisture: 28, temperature: 29, humidity: 62, tankPercent: 76, windSpeed: 11, status: "Dry", timestamp: new Date(Date.now() - 200000).toLocaleTimeString() },
    { id: 3, node: "AF-03", soilMoisture: 51, temperature: 27, humidity: 66, tankPercent: 75, windSpeed: 13, status: "Optimal", timestamp: new Date(Date.now() - 100000).toLocaleTimeString() },
    { id: 4, node: "AF-01", soilMoisture: 43, temperature: 28, humidity: 64, tankPercent: 75, windSpeed: 12, status: "Optimal", timestamp: new Date().toLocaleTimeString() }
  ],
  fields: [
    { id: "A", name: "Field A (Rice Paddy)", crop: "Paddy Rice", stage: "Tillering", area: 2.0, moisture: 42, targetBand: "40% - 60%", method: "Canal / Flood", sensor: "AF-01", status: "Active" },
    { id: "B", name: "Field B (Tomato)", crop: "Tomato", stage: "Flowering", area: 1.5, moisture: 28, targetBand: "35% - 55%", method: "Drip Irrigation", sensor: "AF-02", status: "Dry / Needs Water" },
    { id: "C", name: "Field C (Cotton)", crop: "Cotton", stage: "Squaring", area: 3.0, moisture: 51, targetBand: "40% - 60%", method: "Sprinkler", sensor: "AF-03", status: "Optimal" }
  ],
  tablesCreated: false,
  updatedAt: new Date().toISOString()
};

if (fs.existsSync(LOCAL_STORE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(LOCAL_STORE_FILE, 'utf8'));
    localStore = Object.assign({}, localStore, loaded);
  } catch (err) {
    console.warn('Could not parse local store, using default');
  }
}

function saveLocalStore() {
  try {
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(localStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write local store:', err);
  }
}

// Supabase client
let supabaseClient = null;
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return null;
  }
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabaseClient;
}

// Postgres pool for direct SQL migrations
let pgPool = null;
function getPgPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return null;
  }
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pgPool;
}

// API: Check Supabase connection and configuration status
app.get('/api/status', async (req, res) => {
  const client = getSupabase();
  const hasPg = Boolean(process.env.DATABASE_URL);
  const configured = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));

  if (!client && !hasPg) {
    return res.json({
      configured: false,
      connected: false,
      provider: 'local',
      tablesCreated: localStore.tablesCreated,
      message: 'Supabase credentials (SUPABASE_URL, SUPABASE_ANON_KEY or DATABASE_URL) not yet provided in environment variables.'
    });
  }

  let tableReady = localStore.tablesCreated;
  let statusMsg = 'Connected to Supabase.';

  if (hasPg) {
    try {
      const pool = getPgPool();
      const r = await pool.query("SELECT to_regclass('public.aquafarm_state') as exists;");
      tableReady = Boolean(r.rows[0] && r.rows[0].exists);
      statusMsg = tableReady ? 'Postgres database connected and tables verified.' : 'Postgres database connected. Tables need creation.';
    } catch (err) {
      statusMsg = `Postgres query error: ${err.message}`;
    }
  } else if (client) {
    try {
      const { data, error } = await client.from('aquafarm_state').select('key').limit(1);
      if (error) {
        if (error.code === '42P01') {
          tableReady = false;
          statusMsg = 'Supabase connected. Database tables not created yet.';
        } else {
          statusMsg = `Supabase responded: ${error.message}`;
        }
      } else {
        tableReady = true;
        statusMsg = 'Supabase connected and tables verified.';
      }
    } catch (err) {
      statusMsg = `Connection probe error: ${err.message}`;
    }
  }

  return res.json({
    configured: true,
    connected: true,
    provider: hasPg ? 'supabase-postgres' : 'supabase-api',
    tablesCreated: tableReady,
    message: statusMsg
  });
});

// API: Create / Initialize Tables
app.post('/api/create-tables', async (req, res) => {
  const pool = getPgPool();
  localStore.tablesCreated = true;
  saveLocalStore();

  if (pool) {
    try {
      await pool.query(AQUAFARM_SCHEMA_SQL);
      return res.json({
        success: true,
        method: 'direct_postgres',
        message: 'Successfully executed schema and created all 6 tables in Supabase Postgres!'
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
        message: 'Failed to run SQL via direct connection string. You can also run schema.sql in Supabase SQL editor.'
      });
    }
  }

  // Without direct Postgres connection string, client can copy schema.sql or run in SQL Editor
  return res.json({
    success: true,
    method: 'schema_ready',
    message: 'Table structures and local schema initialized. To create tables directly in your live Supabase database, copy the SQL from /api/schema.sql into the Supabase SQL Editor, or provide DATABASE_URL.'
  });
});

// API: Get complete schema file
app.get('/api/schema.sql', (req, res) => {
  res.type('text/plain').send(AQUAFARM_SCHEMA_SQL);
});

// API: Structured Tables Information for UI
app.get('/api/tables', (req, res) => {
  const databaseCatalog = [
    {
      name: 'aquafarm_state',
      type: 'Key-Value Store',
      columns: 'key (TEXT PK), value (JSONB), updated_at (TIMESTAMPTZ)',
      description: 'Unified app settings, pump configuration, and user preferences',
      rls: 'Enabled (Public Read/Write)'
    },
    {
      name: 'sensor_readings',
      type: 'Timeseries Telemetry',
      columns: 'id (BIGSERIAL PK), sensor_node (TEXT), soil_moisture (NUMERIC), temperature (NUMERIC), humidity (NUMERIC), tank_percent (NUMERIC), created_at (TIMESTAMPTZ)',
      description: 'Historical soil moisture, temperature, and farm environmental sensor ticks',
      rls: 'Enabled (Public Read/Write)'
    },
    {
      name: 'pump_logs',
      type: 'Execution Logs',
      columns: 'id (BIGSERIAL PK), action (TEXT), mode (TEXT), field_id (TEXT), duration_minutes (NUMERIC), water_litres (NUMERIC), created_at (TIMESTAMPTZ)',
      description: 'Irrigation pump start/stop history and water volume usage',
      rls: 'Enabled (Public Read/Write)'
    },
    {
      name: 'farm_alerts',
      type: 'Alerts & Events',
      columns: 'id (TEXT PK), title (TEXT), message (TEXT), severity (TEXT), is_read (BOOLEAN), created_at (TIMESTAMPTZ)',
      description: 'System threshold warnings, sensor warnings, and pump notifications',
      rls: 'Enabled (Public Read/Write)'
    },
    {
      name: 'farm_fields',
      type: 'Field Zones Catalog',
      columns: 'id (TEXT PK), name (TEXT), crop (TEXT), stage (TEXT), area_acres (NUMERIC), target_min (NUMERIC), target_max (NUMERIC), method (TEXT)',
      description: 'Field zones configuration, acreage, crop profiles, and moisture targets',
      rls: 'Enabled (Public Read/Write)'
    },
    {
      name: 'irrigation_schedules',
      type: 'Scheduled Tasks',
      columns: 'id (TEXT PK), field_id (TEXT), scheduled_date (DATE), scheduled_time (TIME), duration_minutes (INT), mode (TEXT), status (TEXT)',
      description: 'Automated and scheduled irrigation runs planned by the farm manager',
      rls: 'Enabled (Public Read/Write)'
    }
  ];

  res.json({
    telemetryLogs: localStore.telemetryLogs || [],
    fields: localStore.fields || [],
    databaseCatalog: databaseCatalog,
    tablesCreated: localStore.tablesCreated
  });
});

// API: Get state
app.get('/api/state', async (req, res) => {
  const client = getSupabase();
  if (!client) {
    return res.json({ success: true, source: 'local', data: localStore });
  }

  try {
    const { data, error } = await client.from('aquafarm_state').select('*');
    if (error) {
      return res.json({ success: true, source: 'local-fallback', data: localStore, error: error.message });
    }
    const result = Object.assign({}, localStore);
    if (Array.isArray(data)) {
      data.forEach(item => {
        result[item.key] = item.value;
      });
    }
    return res.json({ success: true, source: 'supabase', data: result });
  } catch (err) {
    return res.json({ success: true, source: 'local-fallback', data: localStore });
  }
});

// API: Sync state
app.post('/api/state', async (req, res) => {
  const payload = req.body || {};
  Object.keys(payload).forEach(key => {
    localStore[key] = payload[key];
  });
  localStore.updatedAt = new Date().toISOString();
  saveLocalStore();

  const client = getSupabase();
  if (!client) {
    return res.json({ success: true, stored: 'local' });
  }

  try {
    const upserts = Object.keys(payload).map(key => ({
      key,
      value: payload[key],
      updated_at: new Date().toISOString()
    }));

    const { error } = await client.from('aquafarm_state').upsert(upserts);
    if (error) {
      return res.json({ success: true, stored: 'local-with-supabase-warning', error: error.message });
    }
    return res.json({ success: true, stored: 'supabase' });
  } catch (err) {
    return res.json({ success: true, stored: 'local-fallback', error: err.message });
  }
});

// API: Telemetry
app.post('/api/telemetry', async (req, res) => {
  const { soilMoisture, temperature, humidity, tankPercent, waterUsedToday, windSpeed, sensorNode } = req.body || {};
  const newRow = {
    id: Date.now(),
    node: sensorNode || 'AF-01',
    soilMoisture: Number(soilMoisture) || 0,
    temperature: Number(temperature) || 0,
    humidity: Number(humidity) || 0,
    tankPercent: Number(tankPercent) || 0,
    waterUsedToday: Number(waterUsedToday) || 0,
    windSpeed: Number(windSpeed) || 0,
    status: (soilMoisture < 30) ? 'Dry' : (soilMoisture > 70) ? 'Wet' : 'Optimal',
    timestamp: new Date().toLocaleTimeString()
  };

  if (!Array.isArray(localStore.telemetryLogs)) {
    localStore.telemetryLogs = [];
  }
  localStore.telemetryLogs.unshift(newRow);
  if (localStore.telemetryLogs.length > 50) {
    localStore.telemetryLogs.pop();
  }
  localStore.lastSensors = newRow;
  saveLocalStore();

  const client = getSupabase();
  if (client) {
    try {
      await client.from('sensor_readings').insert([
        {
          sensor_node: newRow.node,
          soil_moisture: newRow.soilMoisture,
          temperature: newRow.temperature,
          humidity: newRow.humidity,
          tank_percent: newRow.tankPercent,
          water_used_today: newRow.waterUsedToday,
          wind_speed: newRow.windSpeed
        }
      ]);
    } catch (err) {
      // Continue gracefully
    }
  }

  return res.json({ success: true, row: newRow });
});

// API: Pump logs
app.post('/api/pump', async (req, res) => {
  const { action, mode, fieldId, durationMinutes, waterLitres, soilMoisture } = req.body || {};
  const client = getSupabase();
  if (client) {
    try {
      await client.from('pump_logs').insert([
        {
          action: action || 'TOGGLE',
          mode: mode || 'Manual',
          field_id: fieldId || 'A',
          duration_minutes: durationMinutes || 0,
          water_litres: waterLitres || 0,
          soil_moisture: soilMoisture || 0
        }
      ]);
    } catch (err) {
      // Continue gracefully
    }
  }

  return res.json({ success: true });
});

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AquaFarm server running on http://0.0.0.0:${PORT}`);
});

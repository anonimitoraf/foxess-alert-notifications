/**
 * API "source": logs in over HTTPS, walks every plant and returns normalized
 * alerts. No browser involved, so a check takes a second instead of a minute.
 */

import { dedupeAlerts, sortAlerts } from '../alerts.js';
import { createApiClient } from './client.js';
import { mapAlarmList } from './map.js';

/**
 * @returns {Promise<{
 *   alerts: import('../alerts.js').Alert[],
 *   ignored: import('../alerts.js').Alert[],
 *   sources: {label: string, url: string, rows: number}[],
 *   diagnostics: object,
 * }>}
 */
export async function collectAlerts(config, logger) {
  const startedAt = Date.now();
  const log = logger.child('api');
  const client = createApiClient(config, log);

  const me = await client.ensureToken().then(() => client.userInfo().catch(() => null));
  if (me?.email ?? me?.name) log.debug('authenticated', { identity: me.email ?? me.name });

  const allPlants = await client.listPlants();
  const plants = filterPlants(allPlants, config.api.plantIds, log);
  if (!plants.length) {
    log.warn('the account has no plants to check', {
      plantsReturned: allPlants.length,
      filter: config.api.plantIds,
    });
  }

  const now = new Date();
  const cutoff = config.alerts.lookbackHours > 0 ? now.getTime() - config.alerts.lookbackHours * 60 * 60 * 1000 : null;

  const activeAlerts = [];
  const historyAlerts = [];
  const sources = [];
  let activeCount = 0;
  let historyCount = 0;

  for (const plant of plants) {
    const plantID = plant.plantID ?? plant.id;
    const plantName = plant.plantName ?? plant.name ?? plantID;
    const timezone = await resolveTimezone(plant, plantID, client, config, log);
    const url = `${config.foxess.baseUrl}/v2/plants/alarm?GROUPID=${encodeURIComponent(plantID)}`;

    try {
      if (config.api.scope !== 'history') {
        const { alarms, count } = await client.listActiveAlarms(plantID, { timezone });
        activeCount += alarms.length;
        activeAlerts.push(...mapAlarmList(alarms, { plant, scope: 'active', url, timezone }));
        sources.push({ label: `${plantName} · active`, url, rows: alarms.length });
        log.debug('active alarms fetched', { plant: plantName, rows: alarms.length, alarmCount: count });
      }

      if (config.api.scope !== 'active') {
        const from = new Date(now.getTime() - (config.alerts.lookbackHours || 24) * 60 * 60 * 1000);
        const { alarms } = await client.listHistoryAlarms(plantID, { from, to: now, timezone });
        historyCount += alarms.length;
        historyAlerts.push(...mapAlarmList(alarms, { plant, scope: 'history', url, timezone }));
        sources.push({ label: `${plantName} · history`, url, rows: alarms.length });
        log.debug('history alarms fetched', { plant: plantName, rows: alarms.length });
      }
    } catch (error) {
      // Never report "nothing wrong" because one plant could not be read.
      error.message = `Plant "${plantName}" (${plantID}): ${error.message}`;
      throw error;
    }
  }

  // Active alarms are current problems: age does not disqualify them.
  const freshHistory = cutoff === null ? historyAlerts : historyAlerts.filter((alert) => !isOlderThan(alert, cutoff));
  const ignored = historyAlerts.filter((alert) => !freshHistory.includes(alert));

  const alerts = sortAlerts(dedupeAlerts([...activeAlerts, ...freshHistory]));

  const diagnostics = {
    mode: 'api',
    durationMs: Date.now() - startedAt,
    authenticated: true,
    signer: client.signerMode,
    plantsChecked: plants.length,
    activeAlarms: activeCount,
    historyAlarms: historyCount,
    alertsFromActive: activeAlerts.length,
    alertsFromHistory: historyAlerts.length,
    alertsInWindow: alerts.length,
    ignoredByLookback: ignored.length,
    scope: config.api.scope,
  };

  log.info('api collection finished', { ...diagnostics });
  return { alerts, ignored, sources, diagnostics };
}

/**
 * Alarm timestamps are plant-local, so the zone is not cosmetic: without it an
 * `AEST` timestamp is read as UTC and every alert shifts by hours. `plant/list`
 * omits it, `plant/detail` has it, and FOXESS_TIMEZONE is the manual override.
 */
async function resolveTimezone(plant, plantID, client, config, log) {
  if (plant.timezone) return plant.timezone;

  try {
    const info = await client.getPlantDetail(plantID);
    if (info?.timezone) return info.timezone;
  } catch (error) {
    log.debug('could not read plant detail for its timezone', { plantID, error: error.message });
  }

  if (config.foxess.timezone) return config.foxess.timezone;

  log.warn('plant reports no timezone; alarm times will be read as UTC', {
    plantID,
    fix: 'set FOXESS_TIMEZONE to the plant zone (e.g. Australia/Melbourne)',
  });
  return undefined;
}

function isOlderThan(alert, cutoff) {
  if (!alert.occurredAt) return false;
  const time = Date.parse(alert.occurredAt);
  return !Number.isNaN(time) && time < cutoff;
}

function filterPlants(plants, plantIds, log) {
  if (!plantIds.length) return plants;
  const wanted = new Set(plantIds.map((id) => String(id).toLowerCase()));
  const selected = plants.filter((plant) => {
    const id = String(plant.plantID ?? plant.id ?? '').toLowerCase();
    const name = String(plant.plantName ?? plant.name ?? '').toLowerCase();
    return wanted.has(id) || wanted.has(name);
  });
  if (!selected.length && plants.length) {
    log.warn('FOXESS_PLANT_IDS matched no plant; nothing will be checked', {
      filter: plantIds,
      available: plants.map((plant) => plant.plantID ?? plant.id).slice(0, 10),
    });
  }
  return selected;
}

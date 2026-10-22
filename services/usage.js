// Usage reported by gateways: stored per day, application, product and API; read for charts.
const { Op } = require('sequelize');
const { Application, ApiProduct, UsageRecord } = require('../models');

// Adds per-minute records from a gateway to the daily totals. Returns the number of records stored.
const recordUsage = async (gateway, records) => {
  if (!Array.isArray(records) || !records.length) return 0;

  // Only this organization's products count; anything else is ignored.
  const productIds = [...new Set(records.map((record) => record.productId))];
  const products = new Set((await ApiProduct.findAll({
    where: { id: productIds, organizationId: gateway.organizationId },
    attributes: ['id'],
  })).map((product) => product.id));

  const totals = new Map();
  for (const record of records) {
    if (!products.has(record.productId) || !record.clientId || !record.apiId || typeof record.minute !== 'string') continue;
    const day = record.minute.slice(0, 10);
    const key = `${day}|${record.productId}|${record.apiId}|${record.clientId}`;
    const total = totals.get(key) || { day, productId: record.productId, apiId: record.apiId, clientId: record.clientId, requests: 0, errors: 0, rateLimited: 0, latencyMsTotal: 0 };
    total.requests += Number(record.requests) || 0;
    total.errors += Number(record.errors) || 0;
    total.rateLimited += Number(record.rateLimited) || 0;
    total.latencyMsTotal += Number(record.latencyMsTotal) || 0;
    totals.set(key, total);
  }

  const clientIds = [...new Set([...totals.values()].map((total) => total.clientId))];
  const applications = new Map((await Application.findAll({
    where: { clientId: clientIds },
    attributes: ['id', 'clientId'],
  })).map((application) => [application.clientId, application.id]));

  for (const total of totals.values()) {
    const where = { day: total.day, gatewayId: gateway.id, productId: total.productId, apiId: total.apiId, clientId: total.clientId };
    const existing = await UsageRecord.findOne({ where });
    const amounts = { requests: total.requests, errors: total.errors, rateLimited: total.rateLimited, latencyMsTotal: total.latencyMsTotal };
    if (existing) {
      await existing.increment(amounts);
    } else {
      await UsageRecord.create({
        ...where,
        ...amounts,
        organizationId: gateway.organizationId,
        applicationId: applications.get(total.clientId) || null,
      });
    }
  }
  return totals.size;
};

const lastDays = (days) => {
  const result = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    result.push(date.toISOString().slice(0, 10));
  }
  return result;
};

// Daily series for the last `days` days (including days with no traffic) plus totals.
const usageSeries = async (where, days = 14) => {
  const dates = lastDays(days);
  const rows = await UsageRecord.findAll({ where: { ...where, day: { [Op.gte]: dates[0] } } });
  const byDay = new Map(dates.map((day) => [day, { day, requests: 0, errors: 0, rateLimited: 0, latencyMsTotal: 0 }]));
  for (const row of rows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point.requests += row.requests;
    point.errors += row.errors;
    point.rateLimited += row.rateLimited;
    point.latencyMsTotal += Number(row.latencyMsTotal);
  }
  const points = [...byDay.values()].map((point) => ({
    ...point,
    averageLatencyMs: point.requests ? Math.round(point.latencyMsTotal / point.requests) : null,
  }));
  const totals = points.reduce((sum, point) => ({
    requests: sum.requests + point.requests,
    errors: sum.errors + point.errors,
    rateLimited: sum.rateLimited + point.rateLimited,
  }), { requests: 0, errors: 0, rateLimited: 0 });

  // Top applications over the window, by requests.
  const byApplication = new Map();
  for (const row of rows) {
    const key = row.applicationId || row.clientId;
    const entry = byApplication.get(key) || { applicationId: row.applicationId, clientId: row.clientId, requests: 0, errors: 0 };
    entry.requests += row.requests;
    entry.errors += row.errors;
    byApplication.set(key, entry);
  }
  const applications = [...byApplication.values()].sort((a, b) => b.requests - a.requests).slice(0, 10);
  if (applications.length) {
    const names = new Map((await Application.findAll({
      where: { id: applications.map((entry) => entry.applicationId).filter(Boolean) },
      attributes: ['id', 'name'],
    })).map((application) => [application.id, application.name]));
    applications.forEach((entry) => { entry.name = names.get(entry.applicationId) || entry.clientId; });
  }
  return { days, points, totals, applications };
};

module.exports = { recordUsage, usageSeries };

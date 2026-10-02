import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventDetail} from '../../web/panels/ui.js';

test('environment timeline reads the persisted Runtime sample, not its targets', () => {
  assert.equal(eventDetail({type: 'environment.sampled', payload: {
    chamber_id: 'chamber-01',
    sample: {temperature_c: 36.52, co2_pct: 9.82, humidity_pct: 59.87, sampled_at_sim_s: 30, quality: 'good'},
    targets: {temperature_c: 37, co2_pct: 10, humidity_pct: 60},
  }}), '温度 36.5°C · CO₂ 9.8% · 湿度 59.9%RH');
});

test('missing readings stay unknown, zero is valid, and channel objects remain supported', () => {
  assert.equal(eventDetail({type: 'environment.sampled', payload: {
    sample: {temperature_c: null, co2_pct: 0, humidity_pct: NaN},
    targets: {temperature_c: 37, humidity_pct: 60},
  }}), '温度 —°C · CO₂ 0.0% · 湿度 —%RH');
  assert.equal(eventDetail({type: 'environment.sampled', payload: {
    channels: {temperature_c: {observed: 36.5}, co2_pct: {observed: null, target: 10}},
  }}), '温度 36.5°C · CO₂ —% · 湿度 —%RH');
});

test('environment target changes read the Runtime targets envelope', () => {
  assert.equal(eventDetail({type: 'environment.targets_set', payload: {
    chamber_id: 'chamber-01', targets: {temperature_c: 37, co2_pct: 10, humidity_pct: 60},
  }}), '温度=37 CO₂=10 湿度=60');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAutomationActivity
} = require('../src/automationActivity');

test('automation activity: accepts updates only from the expected sender', () => {
  const activity = createAutomationActivity(42);

  assert.equal(activity.update(42, 'bot1', true), true);
  assert.equal(activity.isActive(), true);

  assert.equal(activity.update(7, 'bot1', false), false);
  assert.equal(activity.isActive(), true);
});

test('automation activity: accepts only bot1 and bot2 tab identifiers', () => {
  const activity = createAutomationActivity(42);

  assert.equal(activity.update(42, 'bot1', true), true);
  assert.equal(activity.update(42, 'bot2', true), true);
  assert.equal(activity.update(42, 'bot3', true), false);
  assert.equal(activity.update(42, '', false), false);
  assert.equal(activity.update(42, null, false), false);

  assert.equal(activity.update(42, 'bot1', false), true);
  assert.equal(activity.isActive(), true);
  assert.equal(activity.update(42, 'bot2', false), true);
  assert.equal(activity.isActive(), false);
});

test('automation activity: requires active to be a strict boolean', () => {
  const activity = createAutomationActivity(42);

  assert.equal(activity.update(42, 'bot1', true), true);

  for (const invalidActive of [1, 0, 'true', 'false', null, undefined, {}]) {
    assert.equal(activity.update(42, 'bot1', invalidActive), false);
    assert.equal(activity.isActive(), true);
  }
});

test('automation activity: rejected input never mutates inactive state', () => {
  const activity = createAutomationActivity(42);

  assert.equal(activity.update(7, 'bot1', true), false);
  assert.equal(activity.update(42, 'other', true), false);
  assert.equal(activity.update(42, 'bot2', 1), false);
  assert.equal(activity.isActive(), false);
});

test('automation activity: reset clears every active tab and reports inactive', () => {
  const activity = createAutomationActivity(42);

  assert.equal(activity.update(42, 'bot1', true), true);
  assert.equal(activity.update(42, 'bot2', true), true);
  assert.equal(activity.isActive(), true);

  assert.equal(activity.reset(), false);
  assert.equal(activity.isActive(), false);

  assert.equal(activity.update(42, 'bot1', false), true);
  assert.equal(activity.isActive(), false);
});

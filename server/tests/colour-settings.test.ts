import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { COLOUR_SETTING_RANGES } from '../src/tool-contracts.js';
import { createCallToolHandler } from '../src/tool-handler.js';

describe('colour grading and calibration', () => {
  const ranges = Object.entries(COLOUR_SETTING_RANGES);

  it.each(ranges)('dispatches both valid bounds for %s', async (key, [minimum, maximum]) => {
    const received: unknown[] = [];
    const handler = createCallToolHandler({
      isReady: () => true,
      dispatcher: { call: async (_action, params) => {
        received.push(params);
        return { id: 'colour', result: { success: true } };
      } },
    });
    for (const value of [minimum, maximum]) {
      const result = await handler('set_develop_settings', { photo_id: 914, settings: { [key]: value } });
      expect(result.isError).not.toBe(true);
    }
    expect(received).toHaveLength(2);
  });

  it.each(ranges)('rejects wrong types and out of range values for %s before dispatch', async (key, [minimum, maximum]) => {
    let calls = 0;
    const handler = createCallToolHandler({
      isReady: () => true,
      dispatcher: { call: async () => {
        calls++;
        return { id: 'colour', result: {} };
      } },
    });
    for (const value of [minimum - 1, maximum + 1, '10', true, [0, 0, 255, 255]]) {
      const result = await handler('set_develop_settings', { photo_id: 914, settings: { [key]: value } });
      expect(result.isError).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('keeps the Lua range table and metadata coverage aligned', () => {
    const lua = readFileSync('../plugin/LightroomMCP.lrplugin/HandlerDevelop.lua', 'utf8');
    const metadata = readFileSync('../plugin/LightroomMCP.lrplugin/HandlerMetadata.lua', 'utf8');
    for (const [key, [minimum, maximum]] of ranges) {
      expect(lua).toContain(`${key} = { ${minimum}, ${maximum} }`);
      expect(metadata).toContain(`"${key}"`);
    }
  });
});

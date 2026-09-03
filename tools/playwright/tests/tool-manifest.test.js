/**
 * tool-manifest.test.js
 *
 * Contract tests for tools/shared/browser-tool-manifest.json.
 * Verifies schema version, required tool entries, profile membership,
 * annotation correctness, and inputSchema/outputSchema presence.
 *
 * Run with: node --test tests/tool-manifest.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, '../../shared/browser-tool-manifest.json');

let manifest;

before(() => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  manifest = JSON.parse(raw);
});

// ---------------------------------------------------------------------------
// Top-level shape
// ---------------------------------------------------------------------------

describe('manifest top-level', () => {
  it('has schema_version owc.browser-manifest.v2', () => {
    assert.equal(manifest.schema_version, 'owc.browser-manifest.v2');
  });

  it('has a tools array', () => {
    assert.ok(Array.isArray(manifest.tools));
    assert.ok(manifest.tools.length >= 8, 'Expected at least 8 tools');
  });

  it('has $defs.ToolEnvelopeV2', () => {
    assert.ok(manifest.$defs?.ToolEnvelopeV2, 'Missing $defs.ToolEnvelopeV2');
  });
});

// ---------------------------------------------------------------------------
// Required tool names
// ---------------------------------------------------------------------------

const REQUIRED_MCP_TOOLS = ['navigate', 'inspect', 'interact', 'screenshot', 'harvest', 'wait'];
const REQUIRED_LANGCHAIN_TOOLS = ['memory_search', 'plan'];

describe('required tools present', () => {
  for (const name of REQUIRED_MCP_TOOLS) {
    it(`has MCP tool: ${name}`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.ok(tool, `Missing MCP tool "${name}"`);
      assert.equal(tool.kind, 'mcp');
    });
  }

  for (const name of REQUIRED_LANGCHAIN_TOOLS) {
    it(`has LangChain tool: ${name}`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.ok(tool, `Missing LangChain tool "${name}"`);
      assert.equal(tool.kind, 'langchain');
    });
  }
});

// ---------------------------------------------------------------------------
// Per-tool required fields
// ---------------------------------------------------------------------------

describe('every tool has required fields', () => {
  it('all tools have name, kind, description, profiles, proof_fields', () => {
    for (const tool of manifest.tools) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `Tool missing name`);
      assert.ok(['mcp', 'langchain'].includes(tool.kind), `Tool ${tool.name}: unknown kind "${tool.kind}"`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 20,
        `Tool ${tool.name}: description too short or missing`);
      assert.ok(Array.isArray(tool.profiles) && tool.profiles.length > 0,
        `Tool ${tool.name}: profiles must be a non-empty array`);
      assert.ok(Array.isArray(tool.proof_fields), `Tool ${tool.name}: proof_fields must be an array`);
    }
  });
});

// ---------------------------------------------------------------------------
// MCP tool annotations
// ---------------------------------------------------------------------------

describe('MCP tools have correct annotations', () => {
  const annotationTests = {
    navigate: { readOnlyHint: false, destructiveHint: false },
    inspect: { readOnlyHint: true, idempotentHint: true },
    interact: { readOnlyHint: false, destructiveHint: false },
    screenshot: { readOnlyHint: true, idempotentHint: true },
    harvest: { readOnlyHint: true },
    wait: { readOnlyHint: true },
  };

  for (const [name, expected] of Object.entries(annotationTests)) {
    it(`${name} annotations are correct`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.ok(tool, `Missing tool ${name}`);
      assert.ok(tool.annotations, `${name}: missing annotations block`);
      for (const [key, val] of Object.entries(expected)) {
        assert.equal(tool.annotations[key], val,
          `${name}.annotations.${key} expected ${val}, got ${tool.annotations[key]}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// mutates_page classification
// ---------------------------------------------------------------------------

describe('mutates_page is correct', () => {
  const mutating = ['navigate', 'interact'];
  const readonly = ['inspect', 'screenshot', 'harvest', 'wait'];

  for (const name of mutating) {
    it(`${name} is mutating`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.equal(tool.mutates_page, true);
    });
  }

  for (const name of readonly) {
    it(`${name} is read-only`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.equal(tool.mutates_page, false);
    });
  }
});

// ---------------------------------------------------------------------------
// Profile membership
// ---------------------------------------------------------------------------

describe('harvest is restricted to hosting + embedded profiles', () => {
  it('harvest profiles = ["hosting", "embedded"]', () => {
    const tool = manifest.tools.find((t) => t.name === 'harvest');
    assert.ok(tool.profiles.includes('hosting'), 'harvest must include hosting');
    assert.ok(tool.profiles.includes('embedded'), 'harvest must include embedded');
    assert.ok(!tool.profiles.includes('classification'), 'harvest must NOT include classification');
    assert.ok(!tool.profiles.includes('landing'), 'harvest must NOT include landing');
  });
});

describe('plan is restricted to landing + hosting + embedded', () => {
  it('plan profiles do not include classification', () => {
    const tool = manifest.tools.find((t) => t.name === 'plan');
    assert.ok(!tool.profiles.includes('classification'), 'plan must NOT include classification');
    assert.ok(tool.profiles.includes('landing'));
    assert.ok(tool.profiles.includes('hosting'));
    assert.ok(tool.profiles.includes('embedded'));
  });
});

describe('memory_search is in all profiles', () => {
  it('memory_search profiles include all four', () => {
    const tool = manifest.tools.find((t) => t.name === 'memory_search');
    for (const p of ['classification', 'landing', 'hosting', 'embedded']) {
      assert.ok(tool.profiles.includes(p), `memory_search must include ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// wait replaces wait_for_page_state: six conditions
// ---------------------------------------------------------------------------

describe('wait tool input schema', () => {
  it('condition enum has exactly six values', () => {
    const tool = manifest.tools.find((t) => t.name === 'wait');
    const conditionEnum = tool.inputSchema?.properties?.condition?.enum;
    assert.ok(Array.isArray(conditionEnum), 'wait.inputSchema.properties.condition.enum missing');
    assert.equal(conditionEnum.length, 6);
    for (const cond of ['duration', 'text_visible', 'text_gone', 'selector_visible', 'media_playing', 'network_quiet']) {
      assert.ok(conditionEnum.includes(cond), `Missing wait condition: ${cond}`);
    }
  });

  it('wait is not cacheable', () => {
    const tool = manifest.tools.find((t) => t.name === 'wait');
    assert.equal(tool.cacheable, false);
  });
});

// ---------------------------------------------------------------------------
// outputSchema references ToolEnvelopeV2 for all MCP tools
// ---------------------------------------------------------------------------

describe('MCP tools reference ToolEnvelopeV2 in outputSchema', () => {
  for (const name of REQUIRED_MCP_TOOLS) {
    it(`${name} outputSchema $ref points to ToolEnvelopeV2`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.ok(tool.outputSchema, `${name}: missing outputSchema`);
      assert.equal(tool.outputSchema.$ref, '#/$defs/ToolEnvelopeV2',
        `${name}: outputSchema.$ref should be #/$defs/ToolEnvelopeV2`);
    });
  }
});

// ---------------------------------------------------------------------------
// ToolEnvelopeV2 required fields
// ---------------------------------------------------------------------------

describe('ToolEnvelopeV2 schema', () => {
  it('required fields include schema_version, ok, tool, request_id, page_state, proof, telemetry', () => {
    const schema = manifest.$defs.ToolEnvelopeV2;
    const required = schema.required;
    for (const field of ['schema_version', 'ok', 'tool', 'request_id', 'page_state', 'proof', 'telemetry']) {
      assert.ok(required.includes(field), `ToolEnvelopeV2.required missing: ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// No duplicate tool names
// ---------------------------------------------------------------------------

describe('tool names are unique', () => {
  it('no two tools share a name', () => {
    const names = manifest.tools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Duplicate tool names detected: ${names}`);
  });
});

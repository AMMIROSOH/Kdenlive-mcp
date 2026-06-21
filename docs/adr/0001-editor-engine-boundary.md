# ADR 0001: editor and render-engine boundary

- Status: Accepted
- Date: 2026-06-21

## Context

The product needs deep timeline editing, headless automation, deterministic state,
and review in an established editor on Windows and Linux. Kdenlive and Shotcut use
MLT; OpenShot is easier to script but has a lower feature ceiling. Forking an
editor would couple the MCP contract to a GUI codebase and substantially increase
maintenance and licensing complexity.

## Decision

Use a strict TypeScript MCP application that owns a versioned, portable JSON
project. Integer project frames and stable UUIDs form its public editing model.
Compile that state into disposable MLT XML and invoke `melt` out of process.
Invoke FFmpeg/ffprobe out of process for inspection and media utilities. Kdenlive
is the primary review/reference editor and is neither forked nor linked into the
application. A separately packaged Python worker will later provide local media
analysis.

The application never treats MLT XML or a Kdenlive project as authoritative.
Future Kdenlive/OTIO imports create a new canonical revision and report fidelity
loss explicitly.

## Licensing boundary

Original repository code is Apache-2.0. MLT and FFmpeg remain separate programs
invoked dynamically. Their binaries, plugins, codecs, and build configurations
retain their own licenses. Distribution must:

1. inventory the exact binaries and enabled components;
2. reproduce all copyright/license notices;
3. provide corresponding source or a valid written offer when required;
4. expose replacement/relinking rights for LGPL components when applicable;
5. identify any GPL-enabled FFmpeg/MLT build and license the combined distribution
   consistently with that build's requirements;
6. avoid non-redistributable codecs and patent assumptions; and
7. produce an SBOM and obtain legal review before release.

Merely launching a program is an architectural separation, not a blanket legal
exemption. `THIRD_PARTY_NOTICES.md` is a development checklist, not legal advice.

## Explicit v1 exclusions

- No Kdenlive fork, in-process plugin, or live co-editing bridge.
- No custom editable GUI or macOS support.
- No paid generation providers.
- No guarantee of lossless round trips outside a documented common subset.
- No MLT XML mutation as project persistence.

## Consequences

Headless behavior can be tested independently of any editor UI, and project files
remain portable. The adapter must explicitly map canonical concepts to available
MLT services. Runtime probing and fidelity warnings are mandatory because MLT and
FFmpeg builds vary. A future GPL Kdenlive bridge must be a separate component and
reuse the same MCP/project contracts.

## Revisit when

Live human/agent co-editing becomes a committed requirement, the documented
Kdenlive subset cannot support target workflows, or out-of-process MLT cannot meet
performance/reliability targets.

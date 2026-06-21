export interface SpikeProject {
  readonly audioResource: string;
  readonly clipAResource: string;
  readonly clipBResource: string;
  readonly title: string;
}

const FPS_NUMERATOR = 30;
const LAST_FRAME = 899;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function property(name: string, value: string): string {
  return `    <property name="${escapeXml(name)}">${escapeXml(value)}</property>`;
}

export function compileSpikeProject(project: SpikeProject): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt LC_NUMERIC="C" producer="main" version="7.38.0">',
    `  <profile description="Kdenlive MCP deterministic 720p30" width="1280" height="720" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="${String(FPS_NUMERATOR)}" frame_rate_den="1" colorspace="709"/>`,
    '  <producer id="clip-a" in="0" out="449">',
    property('mlt_service', 'avformat'),
    property('resource', project.clipAResource),
    '    <filter id="clip-a-effect" in="0" out="449">',
    '      <property name="mlt_service">brightness</property>',
    '      <property name="level">1.08</property>',
    '    </filter>',
    '  </producer>',
    '  <producer id="clip-b" in="0" out="479">',
    property('mlt_service', 'avformat'),
    property('resource', project.clipBResource),
    '  </producer>',
    `  <producer id="audio" in="0" out="${String(LAST_FRAME)}">`,
    property('mlt_service', 'avformat'),
    property('resource', project.audioResource),
    '  </producer>',
    '  <producer id="title" in="0" out="179">',
    property('mlt_service', 'qtext'),
    property('text', project.title),
    property('fgcolour', '0xffffffff'),
    property('bgcolour', '0x00000000'),
    property('family', 'Sans'),
    property('size', '64'),
    property('weight', '700'),
    property('geometry', '0%/72%:100%x20%:100'),
    property('halign', 'center'),
    property('valign', 'middle'),
    '  </producer>',
    '  <playlist id="track-base">',
    '    <entry producer="clip-a" in="0" out="449"/>',
    '    <blank length="450"/>',
    '  </playlist>',
    '  <playlist id="track-incoming">',
    '    <blank length="420"/>',
    '    <entry producer="clip-b" in="0" out="479"/>',
    '  </playlist>',
    '  <playlist id="track-audio">',
    `    <entry producer="audio" in="0" out="${String(LAST_FRAME)}"/>`,
    '  </playlist>',
    '  <playlist id="track-title">',
    '    <blank length="60"/>',
    '    <entry producer="title" in="0" out="179"/>',
    '    <blank length="660"/>',
    '  </playlist>',
    `  <tractor id="main" in="0" out="${String(LAST_FRAME)}">`,
    '    <track producer="track-base"/>',
    '    <track producer="track-incoming"/>',
    '    <track producer="track-audio" hide="video"/>',
    '    <track producer="track-title" hide="audio"/>',
    '    <transition id="dissolve" in="420" out="449">',
    '      <property name="mlt_service">luma</property>',
    '      <property name="a_track">0</property>',
    '      <property name="b_track">1</property>',
    '    </transition>',
    '    <transition id="audio-mix" in="0" out="899">',
    '      <property name="mlt_service">mix</property>',
    '      <property name="a_track">0</property>',
    '      <property name="b_track">2</property>',
    '      <property name="always_active">1</property>',
    '      <property name="sum">1</property>',
    '    </transition>',
    '    <transition id="title-composite" in="60" out="239">',
    '      <property name="mlt_service">qtblend</property>',
    '      <property name="a_track">0</property>',
    '      <property name="b_track">3</property>',
    '      <property name="always_active">1</property>',
    '    </transition>',
    '  </tractor>',
    '</mlt>',
    '',
  ];
  return lines.join('\n');
}

export const defaultSpikeProject: SpikeProject = {
  audioResource: '../../packages/mlt-spike/fixtures/tone.wav',
  clipAResource: '../../packages/mlt-spike/fixtures/clip-a.mkv',
  clipBResource: '../../packages/mlt-spike/fixtures/clip-b.mkv',
  title: 'Kdenlive MCP — Milestone 0',
};

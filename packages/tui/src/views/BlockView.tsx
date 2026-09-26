import { Box, Text } from 'ink';
import type { JSX } from 'react';
import type { Block } from '../render/blocks.js';
import { buildEditDiff } from '../render/diff.js';
import { renderMarkdown } from '../render/markdown.js';
import { toolSummary, truncate } from '../render/tools.js';
import { useTheme } from '../theme/context.js';
import { formatUsage } from './format.js';
import { Spinner } from './Spinner.js';

const PREVIEW_LINES = 12;

interface Props {
  block: Block;
  details: boolean;
  thinking: boolean;
  width: number;
}

export function BlockView({ block, details, thinking, width }: Props) {
  const theme = useTheme();
  const t = theme.tokens;
  switch (block.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={t.primary} bold>
            ›{' '}
          </Text>
          <Text color={t.text}>{block.text}</Text>
          {block.queued ? <Text color={t.muted}> (queued)</Text> : null}
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          {thinking && block.thinking ? (
            <Text color={t.muted} italic>
              {block.thinking}
            </Text>
          ) : null}
          {block.text ? (
            <Text color={t.text}>
              {block.final ? renderMarkdown(block.text, theme, width) : block.text}
            </Text>
          ) : null}
        </Box>
      );
    case 'tool':
      return <ToolBlock block={block} details={details} width={width} />;
    case 'turn-end':
      if (block.outcome === 'error')
        return <Text color={t.error}>✗ {block.message ?? 'the turn failed'}</Text>;
      if (block.outcome === 'cancelled') return <Text color={t.muted}>■ cancelled</Text>;
      return block.usage ? <Text color={t.muted}>· {formatUsage(block.usage)}</Text> : null;
    case 'event':
      return (
        <Text color={t.muted}>
          • {block.label}{' '}
          {truncate(JSON.stringify(block.data) ?? '', Math.max(20, width - block.label.length - 4))}
        </Text>
      );
    case 'notice':
      return (
        <Text
          color={block.tone === 'error' ? t.error : block.tone === 'warning' ? t.warning : t.info}
        >
          {block.text}
        </Text>
      );
  }
}

function ToolBlock({
  block,
  details,
  width,
}: {
  block: Extract<Block, { kind: 'tool' }>;
  details: boolean;
  width: number;
}) {
  const { tokens: t } = useTheme();
  const summary = truncate(toolSummary(block.name, block.args), Math.max(20, width - 2));
  const r = block.result;
  const head = r ? (
    <Text>
      <Text color={r.isError ? t.error : t.success}>{r.isError ? '✗' : '✓'}</Text>
      <Text color={t.text}> {summary}</Text>
    </Text>
  ) : (
    <Spinner label={summary} />
  );

  let body: JSX.Element | null = null;
  if (details && block.name === 'edit') {
    const diff = buildEditDiff(block.args);
    if (diff) {
      body = (
        <Box flexDirection="column" marginLeft={2}>
          {diff.lines.map((l, i) =>
            l.kind === 'hunk' ? (
              <Text key={i} color={t.info}>
                {l.text}
              </Text>
            ) : (
              <Text
                key={i}
                color={l.kind === 'add' ? t.diffAdd : l.kind === 'remove' ? t.diffRemove : t.muted}
              >
                {l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}
                {l.text}
              </Text>
            ),
          )}
        </Box>
      );
    }
  }
  if (!body && r && (details || r.isError)) {
    const lines = r.preview.split('\n');
    const shown = details ? lines.slice(0, PREVIEW_LINES) : lines.slice(0, 1);
    const hidden = details ? lines.length - shown.length : 0;
    body = (
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((l, i) => (
          <Text key={i} color={r.isError ? t.error : t.muted}>
            {truncate(l, Math.max(20, width - 4))}
          </Text>
        ))}
        {hidden > 0 ? <Text color={t.muted}>… {hidden} more lines</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {head}
      {body}
    </Box>
  );
}

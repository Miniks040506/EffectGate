function lineText(text, starts, line) {
  const start = starts[line];
  const end = line + 1 < starts.length ? starts[line + 1] : text.length;
  return text.slice(start, end).replace(/\r?\n$/, "");
}

function atxHeading(value) {
  const match = value.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/u);
  if (!match) return;
  return {
    level: match[1].length,
    title: (match[2] ?? "")
      .replace(/[ \t]+#+[ \t]*$/u, "")
      .trim()
  };
}

function markdownHeadings(text, starts) {
  const headings = [];
  let fence;
  for (let line = 0; line < starts.length; line += 1) {
    if (starts[line] === text.length) continue;
    const value = lineText(text, starts, line);
    const marker = value.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        value.trimStart().slice(marker.length).trim().length === 0
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const heading = atxHeading(value);
    if (heading) headings.push({ ...heading, line });
  }
  return headings;
}

export function buildMarkdownEntries({
  artifact,
  text,
  heading,
  starts,
  offsets,
  render
}) {
  const headings = markdownHeadings(text, starts);
  if (heading === undefined) {
    const entries = headings.map((item) => {
      const start = starts[item.line];
      const end =
        item.line + 1 < starts.length ? starts[item.line + 1] : text.length;
      const rendered = render(offsets[start], offsets[end]);
      const visible = atxHeading(rendered.content.replace(/\r?\n$/, ""));
      return {
        value: {
          level: item.level,
          title: visible?.title ?? "",
          line: item.line + 1
        },
        citation: {
          artifact_id: artifact.artifactId,
          source_digest: artifact.sourceDigest,
          byte_start: offsets[start],
          byte_end: offsets[end]
        },
        redactions: rendered.redactions
      };
    });
    return {
      entries,
      commonRedactions: [],
      mediaType: "application/x-ndjson",
      diagnostic: {
        code: "EG-PROJECT-MARKDOWN-INDEX-001",
        message: "Deterministic ATX Markdown heading index v1 was applied."
      }
    };
  }

  const wanted = heading.trim().normalize("NFC");
  const entries = [];
  for (let index = 0; index < headings.length; index += 1) {
    const item = headings[index];
    if (item.title.normalize("NFC") !== wanted) continue;
    const next = headings.slice(index + 1).find(
      (candidate) => candidate.level <= item.level
    );
    const afterSection = next ? starts[next.line] : text.length;
    for (
      let line = item.line;
      line < starts.length && starts[line] < afterSection;
      line += 1
    ) {
      const start = starts[line];
      const end =
        line + 1 < starts.length ? starts[line + 1] : text.length;
      const rendered = render(offsets[start], offsets[end]);
      entries.push({
        text: rendered.content,
        citation: {
          artifact_id: artifact.artifactId,
          source_digest: artifact.sourceDigest,
          byte_start: offsets[start],
          byte_end: offsets[end]
        },
        redactions: rendered.redactions
      });
    }
  }
  return {
    entries,
    commonRedactions: [],
    mediaType: "text/markdown",
    diagnostic: {
      code: "EG-PROJECT-MARKDOWN-SECTION-001",
      message:
        "Deterministic case-sensitive ATX Markdown section extraction v1 was applied."
    }
  };
}

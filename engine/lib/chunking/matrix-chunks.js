function clean(value) {
  return String(value || "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toChunkWidth(totalChunks = 1) {
  const width = String(Math.max(1, Number(totalChunks) || 1)).length;
  return Math.max(2, width);
}

function formatChunkId(index = 1, width = 2) {
  const numeric = Math.max(1, Number(index) || 1);
  return `c${String(numeric).padStart(Math.max(2, Number(width) || 2), "0")}`;
}

function buildMatrixCells(subjects = [], attributes = []) {
  const subjectList = toArray(subjects);
  const attributeList = toArray(attributes);
  const cells = [];
  subjectList.forEach((subject, subjectIdx) => {
    attributeList.forEach((attribute, attributeIdx) => {
      const subjectId = clean(subject?.id);
      const attributeId = clean(attribute?.id);
      if (!subjectId || !attributeId) return;
      cells.push({
        key: `${subjectId}::${attributeId}`,
        subjectId,
        attributeId,
        subjectIdx,
        attributeIdx,
      });
    });
  });
  return cells;
}

export function createInitialMatrixCellChunks({
  subjects = [],
  attributes = [],
  cellsPerChunk = 12,
} = {}) {
  const allCells = buildMatrixCells(subjects, attributes);
  const chunkSize = Math.max(1, Number(cellsPerChunk) || 1);
  const totalChunks = Math.max(1, Math.ceil(allCells.length / chunkSize));
  const width = toChunkWidth(totalChunks);
  const chunks = [];
  for (let index = 0; index < allCells.length; index += chunkSize) {
    const chunkIndex = chunks.length + 1;
    chunks.push({
      chunkId: formatChunkId(chunkIndex, width),
      parentId: null,
      depth: 0,
      cells: allCells.slice(index, index + chunkSize),
    });
  }
  return {
    chunks,
    allCells,
    width,
  };
}

export function splitMatrixCellChunk(chunk = {}) {
  const cells = toArray(chunk?.cells);
  if (cells.length <= 1) return [];
  const pivot = Math.ceil(cells.length / 2);
  const depth = Math.max(0, Number(chunk?.depth) || 0) + 1;
  return [
    {
      chunkId: `${clean(chunk?.chunkId) || "c01"}.a`,
      parentId: clean(chunk?.chunkId) || null,
      depth,
      cells: cells.slice(0, pivot),
    },
    {
      chunkId: `${clean(chunk?.chunkId) || "c01"}.b`,
      parentId: clean(chunk?.chunkId) || null,
      depth,
      cells: cells.slice(pivot),
    },
  ].filter((item) => toArray(item?.cells).length > 0);
}

export function toChunkManifestEntry(chunk = {}) {
  return {
    chunkId: clean(chunk?.chunkId),
    parentId: clean(chunk?.parentId) || null,
    depth: Math.max(0, Number(chunk?.depth) || 0),
    cells: toArray(chunk?.cells).map((cell) => ({
      subjectId: clean(cell?.subjectId),
      attributeId: clean(cell?.attributeId),
      subjectIdx: Number.isFinite(Number(cell?.subjectIdx)) ? Number(cell.subjectIdx) : null,
      attributeIdx: Number.isFinite(Number(cell?.attributeIdx)) ? Number(cell.attributeIdx) : null,
    })),
  };
}

export function makeChunkManifest(chunks = []) {
  return toArray(chunks)
    .map((chunk) => toChunkManifestEntry(chunk))
    .filter((entry) => entry.chunkId);
}


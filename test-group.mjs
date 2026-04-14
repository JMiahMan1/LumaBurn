import crypto from "crypto";

const state = {
  objects: [
    { id: "A", name: "Rectangle" },
    { id: "B", name: "Circle" },
  ],
  selectedObjectIds: ["A", "B"],
};

function nodeChildren(n) {
  return [];
}

function findParentArray(id, nodes = state.objects) {
  const currentNodes = Array.isArray(nodes) ? nodes : [];
  for (const node of currentNodes) {
    const children = nodeChildren(node);
    if (children.some((child) => child.id === id)) {
      return children;
    }
    const nested = findParentArray(id, children);
    if (nested) {
      return nested;
    }
  }
  return currentNodes.some((node) => node.id === id) ? currentNodes : null;
}

function replaceArrayContents(targetArray, newContents) {
  targetArray.length = 0;
  targetArray.push(...newContents);
}

function groupSelection() {
  if (state.selectedObjectIds.length < 2) {
    console.log("Failed: < 2");
    return;
  }
  const parentArrays = [...new Set(state.selectedObjectIds.map((id) => findParentArray(id)))];
  if (parentArrays.length !== 1 || parentArrays[0] === null) {
    console.log("Failed: not siblings");
    return;
  }
  const parentArray = parentArrays[0];
  const selected = parentArray.filter((node) => state.selectedObjectIds.includes(node.id));
  if (selected.length < 2) {
    console.log("Failed: selected length < 2 in parent", selected);
    return;
  }
  const insertionIndex = parentArray.findIndex((node) => node.id === selected[0].id);
  const group = {
    id: crypto.randomUUID(),
    name: `Group ${selected[0].name}`,
    children: selected.map((n) => ({ ...n })),
  };
  const remaining = parentArray.filter((node) => !state.selectedObjectIds.includes(node.id));
  remaining.splice(insertionIndex, 0, group);
  replaceArrayContents(parentArray, remaining);
  state.selectedObjectIds = [group.id];
  console.log("Success! state.objects length:", state.objects.length);
  console.log("First item:", state.objects[0].name);
}

groupSelection();

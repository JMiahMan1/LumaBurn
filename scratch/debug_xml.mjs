import { parseXmlLite } from "../src/core/gcode.mjs";

const commentXml = "<root><!-- some comment --><Child />? </root>";
console.log("Input XML:", commentXml);
const node = parseXmlLite(commentXml);
console.log("Root node name:", node?.name);
console.log("Children count:", node?.children?.length);
if (node?.children?.length > 0) {
  console.log("Child 0 name:", node.children[0].name);
}
console.log("Text content:", node?.text);

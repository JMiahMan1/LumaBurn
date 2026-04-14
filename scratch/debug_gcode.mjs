import { parseGcodeGeometry } from "../src/core/gcode.mjs";

const gcode = "M4 S1000\nG1 X10 Y10\nG20 G91\nG1 X1 Y1\nG90 G21\nG2 X20 Y20 I5 J5"; 
const polylines = parseGcodeGeometry(gcode);
console.log("Polylines length:", polylines.length);
if (polylines.length > 0) {
  console.log("First polyline:", polylines[0]);
} else {
  console.log("FAILED to parse polylines");
}

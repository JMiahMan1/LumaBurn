# 🚀 LumaBurn Quick-Start Guide

Welcome to LumaBurn! This guide will get you from an SVG file to a finished laser job in 5 easy steps.

---

## 🛠 The 5-Step Workflow

### 1. 📂 Import Your Artwork

Click **File > Import SVG** or drag your `.svg` file directly onto the canvas.

> [!TIP]
> LumaBurn automatically filters out background rectangles that match your document size, keeping your workspace clean!

### 2. 📐 Arrange & Resize

Click a shape to select it. Blue handles will appear:

- **Drag** from the center to move.
- **Drag Corners** to scale.
- **Top Circle** to rotate.

### 3. 🏷 Assign Operations

Select a layer in the right-hand **Layers** list.

- **Line**: For cutting all the way through.
- **Score**: For drawing a thin line on the surface.
- **Hatch/Fill**: For engraving solid areas.

### 4. 🎯 Target Your Job (Framing)

Before you hit run, you need to know where the laser will fire.

1. Click **Frame Path**.
2. The laser will trace the outer boundary of your job (with the laser off or at min power).
3. Adjust your material until it's perfectly aligned.

### 5. ⚡️ Run the Job

Once aligned, click **Run Job** to stream the G-code directly to your ESP3D-enabled device.

---

## 🧩 Helpful Features

### 🔌 Intelligent Device Discovery

LumaBurn automatically scans your local network for ESP3D devices. If yours isn't found, you can manually enter its IP in the **Controller Settings**.

### 🌬 Air Assist Control

Ensure your machine is equipped. You can toggle Air Assist per layer to improve cut quality on woods or protect your lens during high-power scores.

### 🔄 Project Recovery

Save your workspace as a `.lbrn` (JSON) project to resume work later or share settings with others.

---

## ❓ Common Questions

**"My laser isn't moving!"**

- Ensure you have selected the correct **Device IP** in the Controller menu.
- Check the **Activity Log** for error messages like "Alarm" or "Busy".

**"The lines are too dark/light."**

- Select the layer and adjust the **Power (%)** or **Feed (Speed)** in the Material Preset panel.

---

> [!IMPORTANT]
> Always wear protective eyewear for the correct wavelength (e.g., 450nm for most diode lasers) and never leave your laser unattended while running.

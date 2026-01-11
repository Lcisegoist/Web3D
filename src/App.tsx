import { useState, useRef, useEffect, useCallback } from "react";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Volume"; // 引入体渲染配置
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkConeSource from "@kitware/vtk.js/Filters/Sources/ConeSource";
import type vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import type vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkLookupTable from "@kitware/vtk.js/Common/Core/LookupTable";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper"; //
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import * as GeoTIFF from "geotiff";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";

// --- 工具函数：IBM Float 转换 (SEGY 必备) ---
function ibm32ToFloat(uint32: number): number {
  const sign = (uint32 >> 31) & 0x01 ? -1 : 1;
  const exponent = (uint32 >> 24) & 0x7f;
  const mantissa = uint32 & 0x00ffffff;
  return sign * mantissa * Math.pow(16, exponent - 64) * Math.pow(2, -24);
}
function App() {
  const vtkContainerRef = useRef<HTMLDivElement | null>(null);
  const context = useRef<{
    genericRenderWindow: vtkGenericRenderWindow;
    renderWindow: vtkRenderWindow;
    renderer: vtkRenderer;
    coneSource: vtkConeSource;
    actor: vtkActor;
    mapper: vtkMapper;

    imageData?: vtkImageData;
    lookupTable?: vtkLookupTable;
    segyActor?: vtkImageSlice | vtkActor | vtkVolume;
    segyMapper?: vtkImageMapper | vtkMapper | vtkVolumeMapper;
  } | null>(null);
  //分辨率
  const [coneResolution, setConeResolution] = useState(6);
  //点线面
  const [representation, setRepresentation] = useState(2);
  //导入的文件数据
  const [importedData, setImportedData] = useState<vtkImageData | null>(null);
  //文件读取状态
  const [isLoading, setIsLoading] = useState(false);
  //色表选择
  const [colorMap, setColorMap] = useState<string>("rainbow");

  // 提示框状态
  const [showTipModal, setShowTipModal] = useState(false);

  // FIXME:新增：SEGY 数据状态
  const [segyVolume, setSegyVolume] = useState<vtkImageData | null>(null);
  const [sliceMode, setSliceMode] = useState<"I" | "J" | "K">("K"); // I=Inline, J=Crossline, K=Time
  const [sliceIndex, setSliceIndex] = useState(0);
  const [displayMode, setDisplayMode] = useState<
    "2d-standard" | "2d-density" | "2d-area" | "3d"
  >("2d-standard");
  const [segyMeta, setSegyMeta] = useState({
    nInlines: 0,
    nCrosslines: 0,
    nSamples: 0,
  });

  // 创建变面积显示的填充多边形数据
  function createVariableAreaPolyData(
    volume: vtkImageData,
    sliceIndex: number,
    ampScale = 0.03 // 振幅横向缩放
  ): vtkPolyData | null {
    const dims = volume.getDimensions();
    const scalars = volume.getPointData().getScalars();
    if (!scalars) return null;

    const data = scalars.getData() as Float32Array;
    const [nx, ny, nz] = dims;
    const z = Math.min(sliceIndex, nz - 1);

    const points = vtkPoints.newInstance();
    const lines = vtkCellArray.newInstance(); // Wiggle
    const strips = vtkCellArray.newInstance(); // 填充

    let pid = 0;

    // 👉 一条 Inline = 一条地震道
    for (let i = 0; i < nx; i++) {
      const wiggleIds: number[] = [];
      const stripIds: number[] = [];

      for (let j = 0; j < ny; j++) {
        const idx = z * nx * ny + j * nx + i;
        const amp = data[idx];

        const xBase = i;
        const xAmp = i + Math.max(amp, 0) * ampScale; // 只填充正振幅

        // 基线点
        points.insertNextPoint(xBase, j, z);
        const baseId = pid++;

        // 振幅点
        points.insertNextPoint(xAmp, j, z);
        const ampId = pid++;

        wiggleIds.push(ampId);

        // triangle strip 顺序：base, amp, base, amp ...
        stripIds.push(baseId, ampId);
      }

      // Wiggle 折线
      lines.insertNextCell([wiggleIds.length, ...wiggleIds]);

      // 填充 strip（一条 trace 一个）
      strips.insertNextCell([stripIds.length, ...stripIds]);
    }

    const polyData = vtkPolyData.newInstance();
    polyData.setPoints(points);
    polyData.setLines(lines);
    polyData.setStrips(strips);

    return polyData;
  }

  // 创建3D体渲染
  const createSEGYVolumeRendering = useCallback(
    (volume: vtkImageData, opacity: number = 0.7): vtkVolume => {
      // 1. 创建体渲染映射器
      const volumeMapper = vtkVolumeMapper.newInstance();
      volumeMapper.setInputData(volume);
      volumeMapper.setSampleDistance(1.0);
      volumeMapper.setBlendModeToComposite();

      // 2. 创建不透明度传输函数
      const ofun = vtkPiecewiseFunction.newInstance();
      const scalarRange = volume.getPointData().getScalars().getRange();
      const dataRange = Math.abs(scalarRange[1] - scalarRange[0]);

      // 地震数据通常使用S形不透明度函数
      ofun.addPoint(scalarRange[0], 0.0);
      ofun.addPoint(scalarRange[0] + dataRange * 0.1, 0.1);
      ofun.addPoint(scalarRange[0] + dataRange * 0.3, 0.3);
      ofun.addPoint(scalarRange[0] + dataRange * 0.5, opacity);
      ofun.addPoint(scalarRange[0] + dataRange * 0.7, 0.3);
      ofun.addPoint(scalarRange[0] + dataRange * 0.9, 0.1);
      ofun.addPoint(scalarRange[1], 0.0);

      // 3. 创建颜色传输函数
      const ctfun = vtkColorTransferFunction.newInstance();
      setupColorMap2(ctfun, colorMap, scalarRange as [number, number]);

      // 4. 创建Volume Actor
      const volumeActor = vtkVolume.newInstance();
      const volumeProperty = volumeActor.getProperty();
      volumeProperty.setRGBTransferFunction(0, ctfun);
      volumeProperty.setScalarOpacity(0, ofun);
      volumeProperty.setInterpolationTypeToLinear();
      volumeProperty.setShade(true);
      volumeProperty.setAmbient(0.3);
      volumeProperty.setDiffuse(0.8);
      volumeProperty.setSpecular(0.5);
      volumeProperty.setSpecularPower(20);

      volumeActor.setMapper(volumeMapper);

      return volumeActor;
    },
    [colorMap]
  );

  // 修改后的函数：设置颜色传输函数
  function setupColorMap2(
    ctfun: vtkColorTransferFunction,
    type: string,
    range: [number, number]
  ) {
    ctfun.removeAllPoints(); // 先清空旧点

    if (type === "rainbow") {
      // 地震常用的彩虹色：最小值蓝，中间绿/黄，最大值红
      ctfun.addRGBPoint(range[0], 0.0, 0.0, 1.0); // 蓝色
      ctfun.addRGBPoint((range[0] + range[1]) / 2, 0.0, 1.0, 0.0); // 绿色
      ctfun.addRGBPoint(range[1], 1.0, 0.0, 0.0); // 红色
    } else if (type === "bluetored") {
      // 标准地震红白蓝剖面 (Seismic Reverse)
      ctfun.addRGBPoint(range[0], 0.0, 0.0, 1.0); // 负振幅-蓝
      ctfun.addRGBPoint(0, 1.0, 1.0, 1.0); // 零值-白
      ctfun.addRGBPoint(range[1], 1.0, 0.0, 0.0); // 正振幅-红
    } else {
      // 默认灰度
      ctfun.addRGBPoint(range[0], 0.0, 0.0, 0.0); // 黑
      ctfun.addRGBPoint(range[1], 1.0, 1.0, 1.0); // 白
    }
  }
  // FIXME:步骤2：构建 SEGY Volume (三维地震体)
  function buildSEGYVolume(
    traces: Float32Array[], // 所有的道数据
    nInlines: number,
    nCrosslines: number,
    nSamples: number
  ): vtkImageData {
    const imageData = vtkImageData.newInstance();
    // 设置维度：在 VTK 中通常是 (x, y, z) -> (Crossline, Inline, Time)
    imageData.setDimensions(nCrosslines, nInlines, nSamples);
    imageData.setSpacing([1, 1, 1]);
    imageData.setOrigin([0, 0, 0]);

    // 扁平化数据 Float32Array
    // 大小 = Crossline * Inline * Time
    const volumeData = new Float32Array(nCrosslines * nInlines * nSamples);

    // 填充数据
    // 假设 traces 数组是按照 先 Crossline 后 Inline 的顺序排列的 (Standard SEGY sort)
    // 需要根据实际文件头做映射，这里做简化处理：直接填充
    let traceIdx = 0;
    for (let i = 0; i < nInlines; i++) {
      // y
      for (let j = 0; j < nCrosslines; j++) {
        // x
        const trace = traces[traceIdx] || new Float32Array(nSamples);
        for (let k = 0; k < nSamples; k++) {
          // z
          // VTK 索引计算: z * (Nx * Ny) + y * Nx + x
          const vtkIdx = k * (nCrosslines * nInlines) + i * nCrosslines + j;
          volumeData[vtkIdx] = trace[k];
        }
        traceIdx++;
      }
    }

    const dataArray = vtkDataArray.newInstance({
      name: "Amplitude",
      values: volumeData,
      numberOfComponents: 1,
    });

    imageData.getPointData().setScalars(dataArray);
    return imageData;
  }

  // ==================================================================================
  // 📌 核心逻辑 2：创建 Image Slice (标准的 vtk 图像管线)
  // vtkImageData -> vtkImageMapper -> vtkImageSlice
  // ==================================================================================
  function createSEGYImageSlice(
    volume: vtkImageData,
    slicingMode: "I" | "J" | "K",
    index: number
  ) {
    // 1. Mapper
    const mapper = vtkImageMapper.newInstance();
    mapper.setInputData(volume);

    // 设置切片方向
    if (slicingMode === "I")
      mapper.setSlicingMode(vtkImageMapper.SlicingMode.I);
    // X轴切面 (Crossline面)
    else if (slicingMode === "J")
      mapper.setSlicingMode(vtkImageMapper.SlicingMode.J); // Y轴切面 (Inline面)
    else mapper.setSlicingMode(vtkImageMapper.SlicingMode.K); // Z轴切面 (Time切片)

    mapper.setSlice(index);

    // 2. Actor
    const actor = vtkImageSlice.newInstance();
    actor.setMapper(mapper);

    return { mapper, actor };
  }

  // FIXME:步骤1：读取并解析 SEGY 文件

  async function readSEGY(file: File) {
    setIsLoading(true);
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);

    // 简易解析逻辑
    const nSamples = view.getUint16(3220, false); // Binary header 3220
    const formatCode = view.getInt16(3224, false); // 1 = IBM, 5 = IEEE
    const isIBM = formatCode === 1;

    console.log(`SEGY info: Samples=${nSamples}, Format=${formatCode}`);

    const traceHeaderSize = 240;
    const traceDataSize = nSamples * 4;
    const blockSize = traceHeaderSize + traceDataSize;
    const totalSize = buffer.byteLength - 3600; // 去掉 Text(3200) + Binary(400)
    const totalTraces = Math.floor(totalSize / blockSize);

    // 提取 Trace 数据
    const traces: Float32Array[] = [];
    let offset = 3600; // 跳过卷头

    for (let i = 0; i < totalTraces; i++) {
      const traceData = new Float32Array(nSamples);
      const dataStart = offset + traceHeaderSize;

      for (let s = 0; s < nSamples; s++) {
        const valUint = view.getUint32(dataStart + s * 4, false);
        traceData[s] = isIBM
          ? ibm32ToFloat(valUint)
          : view.getFloat32(dataStart + s * 4, false);
      }
      traces.push(traceData);
      offset += blockSize;
    }

    // 估算几何形状 (简化：假设是正方形区域)
    const side = Math.floor(Math.sqrt(totalTraces));
    const nInlines = side;
    const nCrosslines = Math.floor(totalTraces / side);

    console.log(
      `构建几何: Inlines=${nInlines}, Xlines=${nCrosslines}, Total=${totalTraces}`
    );

    // 调用核心构建函数
    const volume = buildSEGYVolume(traces, nInlines, nCrosslines, nSamples);

    setSegyVolume(volume);
    setSegyMeta({ nInlines, nCrosslines, nSamples });
    setSliceIndex(Math.floor(nInlines / 2)); // 默认切中间
    setIsLoading(false);
  }

  // ==================================================================================
  // FIXME:核心逻辑 4：执行渲染 (Render) - 完整修复版
  // ==================================================================================
  const renderSEGYVolumeSlice = useCallback(() => {
    // 1. 基础检查
    if (!context.current || !segyVolume) return;
    const { renderer, renderWindow } = context.current;

    // 2. 清理场景中旧的 Actor
    renderer.removeAllActors();

    // ===========================
    // 分支 A: 3D 体渲染模式
    // ===========================
    if (displayMode === "3d") {
      const volumeActor = createSEGYVolumeRendering(segyVolume, 0.7);
      renderer.addActor(volumeActor);

      // 3D相机视角设置
      const camera = renderer.getActiveCamera();
      const bounds = segyVolume.getBounds();
      const size = Math.max(
        bounds[1] - bounds[0],
        bounds[3] - bounds[2],
        bounds[5] - bounds[4]
      );
      camera.setPosition(0, -size * 2, size * 1.5);
      camera.setFocalPoint(0, 0, 0);
      camera.setViewUp(0, 0, 1);
    }
    // ===========================
    // 分支 B: 2D 切片模式 (标准 / 变密度 / 变面积)
    // ===========================
    else {
      // 获取数据范围，用于后续颜色映射
      const range = segyVolume.getPointData().getScalars().getRange();
      const [min, max] = range;
      const dataRange = max - min;

      // ------------------------------------------------
      // 子模式 B-1: 变面积显示 (Variable Area Fill)
      // ------------------------------------------------
      if (displayMode === "2d-area") {
        // 只支持K切片（Time slice）
        if (sliceMode === "K") {
          const polyData = createVariableAreaPolyData(
            segyVolume,
            sliceIndex,
            0.03
          );

          if (polyData) {
            const mapper = vtkMapper.newInstance();
            mapper.setInputData(polyData);

            // ❌ 变面积不要标量映射
            mapper.setScalarVisibility(false);

            const actor = vtkActor.newInstance();
            actor.setMapper(mapper);

            // 标准地震 wiggle 风格
            actor.getProperty().setColor(0, 0, 0); // 黑色
            actor.getProperty().setLineWidth(1.0);
            actor.getProperty().setOpacity(1.0);
            actor.getProperty().setLighting(false);

            renderer.addActor(actor);
            context.current.segyActor = actor;
            context.current.segyMapper = mapper;
          }
        } else {
          // 对于非K切片，回退到标准图像显示
          const { mapper, actor } = createSEGYImageSlice(
            segyVolume,
            sliceMode,
            sliceIndex
          );

          const ctfun = vtkColorTransferFunction.newInstance();
          setupColorMap2(ctfun, colorMap, range as [number, number]);
          actor.getProperty().setRGBTransferFunction(0, ctfun);

          renderer.addActor(actor);
          context.current.segyActor = actor;
          context.current.segyMapper = mapper;
        }
      }
      // ------------------------------------------------
      // 子模式 B-2 & B-3: 标准显示 / 变密度显示 (Image Slice)
      // ------------------------------------------------
      else {
        const { mapper, actor } = createSEGYImageSlice(
          segyVolume,
          sliceMode,
          sliceIndex
        );

        if (displayMode === "2d-density") {
          // === 变密度逻辑 ===
          const ctfun = vtkColorTransferFunction.newInstance();
          setupColorMap2(ctfun, colorMap, range as [number, number]);

          const ofun = vtkPiecewiseFunction.newInstance();

          // 计算高振幅比例
          const scalars = segyVolume.getPointData().getScalars();
          const data = scalars.getData();
          let highAmplitudeRatio = 0;

          if (data && segyVolume.getDimensions()) {
            const dims = segyVolume.getDimensions();
            // 根据切片方向计算切片大小
            const sliceSize = dims[0] * dims[1];
            // 注意：严格来说这里应该根据 I/J/K 算准确的切片偏移，但为了性能通常只采样

            const sliceOffset = sliceIndex * dims[0]; // 简化索引
            // FIXME:
            // 1. 计算高振幅比例（采样检测，避免性能问题）
            const threshold = min + dataRange * 0.6;

            let highCount = 0;
            // 限制采样循环次数防止卡顿，最大检测前10000个点
            const checkLimit = Math.min(sliceSize, 10000);

            for (let i = 0; i < checkLimit; i++) {
              // 防止数组越界
              const idx = sliceOffset + i;
              if (idx < data.length && Math.abs(data[idx]) > threshold) {
                highCount++;
              }
            }
            highAmplitudeRatio = highCount / checkLimit;
          }

          if (highAmplitudeRatio > 0.05) {
            // 高振幅密集区：高对比度
            ofun.addPoint(min, 0.6);
            ofun.addPoint(min + dataRange * 0.5, 0.9);
            ofun.addPoint(max, 1.0);

            // 基于用户选择的颜色映射创建增强版本
            const enhancedCtfun = vtkColorTransferFunction.newInstance();
            if (colorMap === "rainbow") {
              // 增强版彩虹色：更鲜艳的颜色
              enhancedCtfun.addRGBPoint(range[0], 0.0, 0.0, 1.0); // 深蓝
              enhancedCtfun.addRGBPoint(
                range[0] + dataRange * 0.3,
                0.0,
                0.5,
                1.0
              ); // 亮蓝
              enhancedCtfun.addRGBPoint(
                range[0] + dataRange * 0.5,
                0.0,
                1.0,
                0.0
              ); // 纯绿
              enhancedCtfun.addRGBPoint(
                range[0] + dataRange * 0.7,
                1.0,
                1.0,
                0.0
              ); // 黄
              enhancedCtfun.addRGBPoint(range[1], 1.0, 0.0, 0.0); // 纯红
            } else if (colorMap === "bluetored") {
              // 增强版地震色：更强的对比
              enhancedCtfun.addRGBPoint(range[0], 0.0, 0.0, 0.8); // 深蓝
              enhancedCtfun.addRGBPoint(
                range[0] + dataRange * 0.4,
                0.2,
                0.2,
                1.0
              ); // 浅蓝
              enhancedCtfun.addRGBPoint(0, 1.0, 1.0, 1.0); // 纯白
              enhancedCtfun.addRGBPoint(
                range[1] - dataRange * 0.4,
                1.0,
                0.4,
                0.4
              ); // 浅红
              enhancedCtfun.addRGBPoint(range[1], 0.8, 0.0, 0.0); // 深红
            } else {
              // 其他颜色映射保持原样
              setupColorMap2(
                enhancedCtfun,
                colorMap,
                range as [number, number]
              );
            }
            actor.getProperty().setRGBTransferFunction(0, enhancedCtfun);
          } else {
            // 普通区域 - 使用用户选择的颜色映射
            ofun.addPoint(min, 0.1);
            ofun.addPoint(min + dataRange * 0.5, 0.7);
            ofun.addPoint(max, 1.0);
            actor.getProperty().setRGBTransferFunction(0, ctfun);
          }

          actor.getProperty().setScalarOpacity(0, ofun);
        } else {
          // === 标准模式 ===
          const ctfun = vtkColorTransferFunction.newInstance();
          setupColorMap2(ctfun, colorMap, range as [number, number]);
          actor.getProperty().setRGBTransferFunction(0, ctfun);
        }

        renderer.addActor(actor);
        context.current.segyActor = actor;
        context.current.segyMapper = mapper;
      }

      // 3. 2D 模式下的通用相机调整
      // 固定相机参数，确保所有切片显示大小一致
      const camera = renderer.getActiveCamera();
      if (sliceMode === "K") {
        // Time slice: XY平面, Z轴朝上
        camera.setPosition(0, 0, 1);
        camera.setFocalPoint(0, 0, 0);
        camera.setViewUp(0, 1, 0);
        // 设置固定的视场角，确保一致的缩放
        camera.setViewAngle(30);
      } else if (sliceMode === "I") {
        // Crossline: YZ平面 (侧视)
        camera.setPosition(1, 0, 0);
        camera.setFocalPoint(0, 0, 0);
        camera.setViewUp(0, 0, 1);
        camera.setViewAngle(30);
      } else if (sliceMode === "J") {
        // Inline: XZ平面 (正视)
        camera.setPosition(0, 1, 0);
        camera.setFocalPoint(0, 0, 0);
        camera.setViewUp(0, 0, 1);
        camera.setViewAngle(30);
      }
    }

    // 4. 全局收尾：重置相机并渲染
    renderer.resetCamera();
    renderer.resetCameraClippingRange(); // 这一步很重要，防止切片被剪裁掉
    renderWindow.render();

    console.log(
      `已渲染 SEGY: Mode=${displayMode}, Slice=${sliceMode}, Index=${sliceIndex}`
    );
  }, [
    segyVolume,
    sliceMode,
    sliceIndex,
    colorMap,
    displayMode,
    createSEGYVolumeRendering,
  ]);

  //功能2：根据数据构建三维曲面
  async function readGeoTIFF(file: File): Promise<vtkImageData> {
    const arrayBuffer = await file.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();

    const width = image.getWidth();
    const height = image.getHeight();

    // 读取第一个波段（灰度 / DEM）
    const raster = await image.readRasters({ samples: [0] });
    const values = raster[0] as Float32Array | Uint16Array | Uint8Array;

    // 转 Float32（vtk 用这个最稳）
    const heightArray = new Float32Array(width * height);
    for (let i = 0; i < heightArray.length; i++) {
      heightArray[i] = values[i];
    }

    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(width, height, 1);
    imageData.setSpacing([1, 1, 1]);
    imageData.setOrigin([0, 0, 0]);

    const scalars = vtkDataArray.newInstance({
      name: "Height",
      values: heightArray,
      numberOfComponents: 1,
    });

    imageData.getPointData().setScalars(scalars);

    console.log("GeoTIFF 读取成功");
    console.log("尺寸:", width, height);
    console.log("高度范围:", scalars.getRange());

    return imageData;
  }

  // 将 ImageData 转换为 PolyData 用于地形渲染
  function imageDataToPolyData(imageData: vtkImageData): vtkPolyData {
    const dims = imageData.getDimensions();
    const width = dims[0];
    const height = dims[1];

    const polyData = vtkPolyData.newInstance();
    const points = vtkPoints.newInstance();
    const polys = vtkCellArray.newInstance();

    // 获取标量数据
    const scalars = imageData.getPointData().getScalars();
    const scalarData = scalars
      ? (scalars.getData() as Float32Array)
      : new Float32Array(width * height);

    // 创建顶点和面
    const numPoints = width * height;
    const pointValues = new Float32Array(numPoints * 3); // x, y, z
    const polyValues = new Uint32Array((width - 1) * (height - 1) * 5); // 四边形面

    let pointIdx = 0;
    let polyIdx = 0;

    // 创建顶点 - 将坐标居中并缩放
    const centerX = width / 2;
    const centerY = height / 2;
    const scale = Math.min(10 / width, 10 / height); // 缩放到合适大小

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;
        const rawValue = scalarData[idx];

        // ① 过滤 GeoTIFF NoData（Float32 最小值）
        const valid = rawValue > -1e20 && Number.isFinite(rawValue);

        // ② 对无效点设置NaN，VTK会自动跳过这些点
        const heightValue = valid ? rawValue * 0.01 : NaN;

        //FIXME:高度也适当缩放

        pointValues[pointIdx * 3] = (i - centerX) * scale; // x (居中)
        pointValues[pointIdx * 3 + 1] = (j - centerY) * scale; // y (居中)
        pointValues[pointIdx * 3 + 2] = heightValue; // z (高度)
        pointIdx++;
      }
    }

    // 创建四边形面
    for (let j = 0; j < height - 1; j++) {
      for (let i = 0; i < width - 1; i++) {
        const p0 = j * width + i;
        const p1 = j * width + i + 1;
        const p2 = (j + 1) * width + i + 1;
        const p3 = (j + 1) * width + i;

        polyValues[polyIdx++] = 4; // 四边形
        polyValues[polyIdx++] = p0;
        polyValues[polyIdx++] = p1;
        polyValues[polyIdx++] = p2;
        polyValues[polyIdx++] = p3;
      }
    }

    points.setData(pointValues);
    polys.setData(polyValues);

    polyData.setPoints(points);
    polyData.setPolys(polys);

    // 设置标量数据
    if (scalars) {
      const polyScalars = vtkDataArray.newInstance({
        name: "Height",
        values: scalars.getData(), // 拷贝值
        numberOfComponents: 1,
      });

      polyData.getPointData().setScalars(polyScalars);
      polyData.getPointData().setActiveScalars("Height");
    }

    console.log("PolyData 创建完成");
    console.log("PolyData 边界:", polyData.getBounds());
    return polyData;
  }

  // 设置不同色表的颜色映射
  function setupColorMap(
    lut: vtkLookupTable,
    colorMapType: string,
    dataRange: [number, number]
  ) {
    lut.setMappingRange(dataRange[0], dataRange[1]);

    switch (colorMapType) {
      case "rainbow":
        // 彩虹色表：蓝->青->绿->黄->红
        lut.setHueRange([0.666, 0.0]);
        lut.setSaturationRange([1.0, 1.0]);
        lut.setValueRange([1.0, 1.0]);
        break;

      case "hot":
        // 热力图：黑->红->黄->白
        lut.setHueRange([0.0, 0.083]);
        lut.setSaturationRange([1.0, 1.0]);
        lut.setValueRange([0.0, 1.0]);
        break;

      case "cool":
        // 冷暖色表：蓝->白->红
        lut.setHueRange([0.666, 0.0]);
        lut.setSaturationRange([0.5, 1.0]);
        lut.setValueRange([0.8, 1.0]);
        break;

      case "grayscale":
        // 灰度色表
        lut.setHueRange([0.0, 0.0]);
        lut.setSaturationRange([0.0, 0.0]);
        lut.setValueRange([0.0, 1.0]);
        break;

      case "bluetored":
        // 蓝到红
        lut.setHueRange([0.666, 0.0]);
        lut.setSaturationRange([1.0, 1.0]);
        lut.setValueRange([1.0, 1.0]);
        break;

      case "terrain":
        // 地形色表：深蓝->浅蓝->绿->黄->棕
        lut.setHueRange([0.75, 0.166]);
        lut.setSaturationRange([0.8, 0.8]);
        lut.setValueRange([0.3, 1.0]);
        break;

      default:
        // 默认彩虹色表
        lut.setHueRange([0.666, 0.0]);
    }

    lut.build();
  }

  // 渲染地形曲面的函数
  async function renderTerrain() {
    if (!context.current || !importedData) {
      throw new Error("数据或上下文不存在");
    }

    const { renderer, renderWindow } = context.current;

    // 1. 将 ImageData 转换为 PolyData
    const polyData = imageDataToPolyData(importedData);
    console.log(
      "PolyData 转换完成，顶点数:",
      polyData.getPoints().getNumberOfPoints()
    );
    console.log("PolyData 面数:", polyData.getPolys().getNumberOfCells());

    // 2. 创建mapper
    const mapper = vtkMapper.newInstance();
    mapper.setInputData(polyData);
    // 强制开启标量着色
    mapper.setScalarVisibility(true);
    mapper.setScalarModeToUsePointData();
    mapper.setColorModeToMapScalars();
    mapper.setInterpolateScalarsBeforeMapping(false);
    // 3. 设置颜色映射
    const dataRange = polyData.getPointData().getScalars().getRange();

    console.log("真实高度范围:", dataRange);
    console.log("使用的色表:", colorMap);

    const lut = vtkLookupTable.newInstance();
    lut.setNumberOfColors(256);
    setupColorMap(lut, colorMap, dataRange as [number, number]);

    mapper.setLookupTable(lut);
    mapper.setUseLookupTableScalarRange(true);

    // 设置标量模式和颜色模式
    mapper.setScalarModeToUsePointData();
    mapper.setColorModeToMapScalars();

    // 忽略NaN值
    mapper.setInterpolateScalarsBeforeMapping(false);

    // 4. 创建 Actor
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    actor.getProperty().setRepresentation(representation);

    console.log("Actor 创建完成，representation:", representation);

    // 5. 渲染
    renderer.removeAllActors();
    renderer.addActor(actor);

    // 设置背景颜色以便更好地看到地形
    renderer.setBackground(0.8, 0.8, 0.8); // 浅灰色背景

    renderer.resetCamera();
    const camera = renderer.getActiveCamera();
    camera.setPosition(0, -20, 20);
    camera.setFocalPoint(0, 0, 0);
    camera.setViewUp(0, 0, 1);
    renderer.resetCameraClippingRange();
    console.log("相机位置:", camera.getPosition());
    console.log("相机焦点:", camera.getFocalPoint());

    renderWindow.render();

    console.log("三维地形绘制成功");
  }

  // 监听切片参数变化，自动重绘
  useEffect(() => {
    if (segyVolume) {
      renderSEGYVolumeSlice();
    }
  }, [
    segyVolume,
    sliceMode,
    sliceIndex,
    colorMap,
    displayMode,
    renderSEGYVolumeSlice,
  ]);

  //初始化vtk
  //顺序：源-映射器(把“几何数据”翻译成 GPU 能画的东西)-演员(可被放进场景的对象)-渲染器-渲染窗口
  //渲染器和渲染窗口都来自fullScreenRenderer
  useEffect(() => {
    if (!context.current && vtkContainerRef.current) {
      //创建全屏渲染窗口
      const genericRenderWindow = vtkGenericRenderWindow.newInstance();
      genericRenderWindow
        .getInteractor()
        .setInteractorStyle(vtkInteractorStyleTrackballCamera.newInstance());

      genericRenderWindow.setContainer(vtkContainerRef.current);
      genericRenderWindow.resize();
      //创建锥体源
      const coneSource = vtkConeSource.newInstance({ height: 1.0 });
      //创建映射器
      const mapper = vtkMapper.newInstance();
      mapper.setInputConnection(coneSource.getOutputPort());

      //创建演员
      const actor = vtkActor.newInstance();
      //设置映射器
      actor.setMapper(mapper);

      //获取渲染器,渲染窗口
      const renderer = genericRenderWindow.getRenderer();
      const renderWindow = genericRenderWindow.getRenderWindow();

      renderer.addActor(actor);
      //重置相机
      renderer.resetCamera();
      //渲染
      renderWindow.render();

      context.current = {
        genericRenderWindow,
        renderWindow,
        renderer,
        coneSource,
        actor,
        mapper,
      };
    }
    //清空context.current
    return () => {
      if (context.current) {
        const { genericRenderWindow, coneSource, actor, mapper } =
          context.current;
        actor.delete();
        mapper.delete();
        coneSource.delete();
        genericRenderWindow.delete();
        context.current = null;
      }
    };
  }, []);

  //更新锥体分辨率
  useEffect(() => {
    if (context.current) {
      const { coneSource, renderWindow } = context.current;
      coneSource.setResolution(coneResolution);
      renderWindow.render();
    }
  }, [coneResolution]);

  useEffect(() => {
    if (context.current) {
      const { actor, renderWindow } = context.current;
      actor.getProperty().setRepresentation(representation);
      renderWindow.render();
    }
  }, [representation]);

  return (
    <>
      {/* 使用提示弹窗 */}
      {showTipModal && (
        <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-gray-800">使用指南</h2>
              <button
                onClick={() => setShowTipModal(false)}
                className="text-gray-500 hover:text-gray-700 text-2xl hover:cursor-pointer"
              >
                ×
              </button>
            </div>

            <div className="space-y-3 text-gray-700">
              <div className="border-l-4 border-blue-500 pl-3">
                <h3 className="font-semibold text-blue-800">功能介绍</h3>
                <p className="text-sm pl-1 pt-2">
                  本应用支持Segy数据可视化和tiff数据3D渲染
                </p>
              </div>

              <div className="border-l-4 border-green-500 pl-3">
                <h3 className="font-semibold text-green-800 mb-2">窗口操作</h3>
                <ul className="text-sm space-y-1 pl-2">
                  <li>
                    <strong>Ctrl + 鼠标：</strong>旋转
                  </li>
                  <li>
                    <strong>Shift + 鼠标：</strong>平移
                  </li>
                  <li>
                    <strong>滚轮：</strong>缩放
                  </li>
                </ul>
              </div>

              <div className="border-l-4 border-purple-500 pl-3">
                <h3 className="font-semibold text-purple-800">参数设置</h3>
                <ul className="text-sm space-y-1 pl-2 pt-2">
                  <li>
                    <strong>分辨率：</strong>仅使用锥体示例
                  </li>
                  <li>
                    <strong>Surface：</strong>
                    图像表面类型，包括点、曲面、填充曲面
                  </li>
                  <li>
                    <strong>色表：</strong>
                    可选择三维曲面色表的不同投影方式，然后点击重新渲染
                  </li>
                </ul>
              </div>

              <div className="border-l-4 border-orange-500 pl-3">
                <h3 className="font-semibold text-orange-800">菜单</h3>
                <p className="py-2 text-sm font-bold">
                  主要包括tiff数据3D渲染和Segy数据可视化两个功能
                </p>
                <ul className="text-sm space-y-1 p-2">
                  <li>
                    <strong>功能1:</strong>
                    导入tif数据后根据选择的表面类型和色表进行三维渲染
                  </li>
                  <li>
                    <strong>功能2:</strong>
                    导入Segy数据后可选择变面积、变密度或三维渲染方式
                  </li>
                </ul>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowTipModal(false)}
                className="hover:cursor-pointer px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <div className=" flex flex-row w-full h-full gap-3">
        <div className="w-[80%] h-full rounded-md" ref={vtkContainerRef} />
        <div className="flex-1 mx-3 my-2 ">
          <div className="mx-auto relative p-2 w-[80%]">
            <button
              className="group relative px-8 py-4 bg-gradient-to-br from-pink-400 to-rose-400 hover:from-pink-500 hover:to-rose-500 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] transition-all duration-300 ease-out cursor-pointer w-full max-w-md mx-auto flex items-center justify-center gap-3"
              onClick={() => setShowTipModal(true)}
            >
              {/* 图标 */}
              <svg
                className="w-5 h-5 transition-transform group-hover:scale-110"
                viewBox="0 0 1024 1024"
                version="1.1"
                xmlns="http://www.w3.org/2000/svg"
                p-id="4729"
                width="200"
                height="200"
              >
                <path
                  d="M512 504.32m-314.88 0a12.3 12.3 0 1 0 629.76 0 12.3 12.3 0 1 0-629.76 0Z"
                  p-id="4730"
                  fill="#ffffff"
                ></path>
                <path
                  d="M560.64 972.8l-94.72 0c-15.36 0-25.6 10.24-25.6 25.6 0 15.36 10.24 25.6 25.6 25.6l94.72 0c15.36 0 25.6-10.24 25.6-25.6C586.24 985.6 573.44 972.8 560.64 972.8z"
                  p-id="4731"
                  fill="#ffffff"
                ></path>
                <path
                  d="M627.2 867.84l-230.4 0c-15.36 0-25.6 10.24-25.6 25.6 0 15.36 10.24 25.6 25.6 25.6l230.4 0c15.36 0 25.6-10.24 25.6-25.6C652.8 878.08 640 867.84 627.2 867.84z"
                  p-id="4732"
                  fill="#ffffff"
                ></path>
                <path
                  d="M514.56 130.56c15.36 0 25.6-10.24 25.6-25.6L540.16 25.6c0-15.36-10.24-25.6-25.6-25.6s-25.6 10.24-25.6 25.6l0 79.36C488.96 117.76 499.2 130.56 514.56 130.56z"
                  p-id="4733"
                  fill="#ffffff"
                ></path>
                <path
                  d="M243.2 235.52c10.24-10.24 10.24-25.6 0-35.84L189.44 143.36c-10.24-10.24-25.6-10.24-35.84 0C143.36 153.6 143.36 168.96 151.04 179.2l56.32 56.32C217.6 245.76 235.52 245.76 243.2 235.52z"
                  p-id="4734"
                  fill="#ffffff"
                ></path>
                <path
                  d="M104.96 478.72 25.6 478.72c-15.36 0-25.6 10.24-25.6 25.6 0 15.36 10.24 25.6 25.6 25.6l79.36 0c15.36 0 25.6-10.24 25.6-25.6C130.56 488.96 117.76 478.72 104.96 478.72z"
                  p-id="4735"
                  fill="#ffffff"
                ></path>
                <path
                  d="M998.4 481.28l-79.36 0c-15.36 0-25.6 10.24-25.6 25.6 0 15.36 10.24 25.6 25.6 25.6L998.4 532.48c15.36 0 25.6-10.24 25.6-25.6C1024 494.08 1013.76 481.28 998.4 481.28z"
                  p-id="4736"
                  fill="#ffffff"
                ></path>
                <path
                  d="M844.8 140.8l-56.32 56.32c-10.24 10.24-10.24 25.6 0 35.84 10.24 10.24 25.6 10.24 35.84 0l56.32-56.32c10.24-10.24 10.24-25.6 0-35.84C870.4 130.56 852.48 130.56 844.8 140.8z"
                  p-id="4737"
                  fill="#ffffff"
                ></path>
              </svg>

              {/* 文字 */}
              <span className="text-lg tracking-wide">使用 Tip</span>
            </button>
          </div>
          <table
            className="w-full rounded-md self-start bg-blue-50"
            style={{ padding: "0" }}
          >
            <tbody className="border border-gray-300 rounded-md">
              <p className="text-lg m-3 ml-1 font-bold text-blue-800">
                参数设置
              </p>
              <tr>
                <td style={{ padding: "0.25rem 0.5rem 1.25rem 0.25rem" }}>
                  <select
                    value={representation}
                    className="bg-gray-200 w-full mb-2"
                    onInput={(ev) =>
                      setRepresentation(
                        Number((ev.target as HTMLSelectElement).value)
                      )
                    }
                  >
                    <option value="0">Points</option>
                    <option value="1">Wireframe</option>
                    <option value="2">Surface</option>
                  </select>
                  <p className="text-sm ml-1 mb-2">
                    type: {["Points", "Wireframe", "Surface"][representation]}
                  </p>
                  <hr />
                  <select
                    value={colorMap}
                    className="bg-gray-200 w-full my-2"
                    onInput={(ev) =>
                      setColorMap((ev.target as HTMLSelectElement).value)
                    }
                  >
                    <option value="rainbow">彩虹色表</option>
                    <option value="hot">热力图</option>
                    <option value="cool">冷暖色表</option>
                    <option value="grayscale">灰度</option>
                    <option value="bluetored">蓝到红</option>
                    <option value="terrain">地形色表</option>
                  </select>
                  <p className="text-sm ml-1">
                    色表:{" "}
                    {
                      {
                        rainbow: "彩虹",
                        hot: "热力图",
                        cool: "冷暖",
                        grayscale: "灰度",
                        bluetored: "蓝红",
                        terrain: "地形",
                      }[colorMap]
                    }
                  </p>
                </td>
              </tr>
              <tr>
                <td style={{ padding: 0 }}>
                  <input
                    className="hover:cursor-pointer"
                    type="range"
                    min="4"
                    max="80"
                    value={coneResolution}
                    onChange={(ev) =>
                      setConeResolution(Number(ev.target.value))
                    }
                  />
                  <div className="text-sm">
                    分辨率：{coneResolution} (仅限锥体示例有效)
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="flex flex-col mt-5 border border-gray-300 rounded-md py-4 px-3 gap-2">
            <h2 className="text-lg font-bold mt-0 ">菜单</h2>
            <hr />
            <div className="flex flex-col bg-blue-50 border rounded-md p-4">
              <h3 className="text-blue-800 font-bold">功能1：三维曲面可视化</h3>
              <input
                className="w-full mt-2 text-sm hover:cursor-pointer border rounded-md p-1 hover:bg-blue-600 hover:text-white text-center"
                type="file"
                accept=".tif,.tiff"
                onChange={async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (!file) return;

                  setIsLoading(true);
                  try {
                    const imageData = await readGeoTIFF(file);
                    setImportedData(imageData);
                  } catch (err) {
                    console.error("GeoTIFF 读取失败:", err);
                  } finally {
                    setIsLoading(false);
                  }
                }}
              />

              <button
                className="text-sm mx-auto bg-blue-500 hover:bg-blue-700 hover:text-white text-black py-2 px-4 rounded mt-2 hover:cursor-pointer w-[50%] text-center"
                onClick={renderTerrain}
                disabled={!importedData || isLoading}
              >
                绘制三维曲面
              </button>

              <button
                className="text-sm mx-auto bg-green-500 hover:bg-green-700 text-black py-2 px-4 rounded mt-2 hover:text-white hover:cursor-pointer w-[50%]"
                onClick={renderTerrain}
                disabled={!importedData || isLoading}
              >
                重新绘制
              </button>
            </div>

            <hr />
            <div className="border p-4 rounded bg-blue-50">
              <h3 className="font-bold text-blue-800">
                功能2：SEGY 地震数据显示
              </h3>
              <input
                type="file"
                accept=".sgy,.segy"
                className="w-full mt-2 text-sm hover:cursor-pointer border rounded-md p-1 hover:bg-blue-600 hover:text-white"
                onChange={(e) =>
                  e.target.files?.[0] && readSEGY(e.target.files[0])
                }
              />

              {segyVolume && (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="text-xs text-gray-600">
                    Dims: {segyMeta.nCrosslines} x {segyMeta.nInlines} x{" "}
                    {segyMeta.nSamples}
                  </div>

                  {/* 显示模式选择 */}
                  <div className="flex gap-1 mb-2">
                    <button
                      className={`flex-1 text-xs py-1 ${
                        displayMode === "2d-standard"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200"
                      }`}
                      onClick={() => setDisplayMode("2d-standard")}
                    >
                      2D标准
                    </button>
                    <button
                      className={`flex-1 text-xs py-1 ${
                        displayMode === "2d-density"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200"
                      }`}
                      onClick={() => setDisplayMode("2d-density")}
                    >
                      变密度
                    </button>
                    <button
                      className={`flex-1 text-xs py-1 ${
                        displayMode === "2d-area"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200"
                      }`}
                      onClick={() => setDisplayMode("2d-area")}
                    >
                      变面积
                    </button>
                    <button
                      className={`flex-1 text-xs py-1 ${
                        displayMode === "3d"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200"
                      }`}
                      onClick={() => setDisplayMode("3d")}
                    >
                      3D体渲染
                    </button>
                  </div>

                  {/* 切片模式选择和控制 - 仅在2D模式下显示 */}
                  {displayMode !== "3d" && (
                    <>
                      <div className="flex gap-1">
                        <button
                          className={`flex-1 text-xs py-1 disabled:bg-gray-500 disabled:text-red-700 disabled:cursor-not-allowed ${
                            sliceMode === "J"
                              ? "bg-blue-600 text-white"
                              : "bg-gray-200"
                          }`}
                          disabled={displayMode === "2d-area"}
                          onClick={() => {
                            setSliceMode("J");
                            setSliceIndex(Math.floor(segyMeta.nInlines / 2));
                          }}
                        >
                          Inline (Y)
                        </button>
                        <button
                          className={`flex-1 text-xs py-1 disabled:bg-gray-500 disabled:text-red-700 disabled:cursor-not-allowed ${
                            sliceMode === "I"
                              ? "bg-blue-600 text-white"
                              : "bg-gray-200"
                          }`}
                          disabled={displayMode === "2d-area"}
                          onClick={() => {
                            setSliceMode("I");
                            setSliceIndex(Math.floor(segyMeta.nCrosslines / 2));
                          }}
                        >
                          Crossline (X)
                        </button>
                        <button
                          className={`flex-1 text-xs py-1 ${
                            sliceMode === "K"
                              ? "bg-blue-600 text-white"
                              : "bg-gray-200"
                          }`}
                          onClick={() => {
                            setSliceMode("K");
                            setSliceIndex(Math.floor(segyMeta.nSamples / 2));
                          }}
                        >
                          Time (Z)
                        </button>
                      </div>

                      {/* 切片滑块 */}
                      <input
                        type="range"
                        className="w-full"
                        min="0"
                        max={
                          sliceMode === "I"
                            ? segyMeta.nCrosslines - 1
                            : sliceMode === "J"
                            ? segyMeta.nInlines - 1
                            : segyMeta.nSamples - 1
                        }
                        value={sliceIndex}
                        onChange={(e) => setSliceIndex(Number(e.target.value))}
                      />
                      <div className="text-center text-xs">
                        Slice Index: {sliceIndex}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default App;

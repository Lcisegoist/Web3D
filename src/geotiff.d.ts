declare module 'geotiff' {
  export interface GeoTIFFImage {
    getWidth(): number;
    getHeight(): number;
    readRasters(options?: { samples?: number[] }): Promise<(Float32Array | Uint16Array | Uint8Array)[]>;
  }

  export interface GeoTIFF {
    getImage(index?: number): Promise<GeoTIFFImage>;
  }

  export function fromArrayBuffer(buffer: ArrayBuffer): Promise<GeoTIFF>;
}

import AppKit
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

private let mirrorBundleID = "com.apple.ScreenContinuity"

final class FrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private let output = FileHandle.standardOutput
    private var lastFrame: UInt64 = 0
    private let minFrameGap: UInt64 = 50_000_000 // At most 20 preview frames per second.

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = DispatchTime.now().uptimeNanoseconds
        guard time - lastFrame >= minFrameGap else { return }
        lastFrame = time
        autoreleasepool {
            let image = CIImage(cvPixelBuffer: pixelBuffer)
            guard let full = context.createCGImage(image, from: image.extent) else { return }
            let width = CGFloat(full.width), height = CGFloat(full.height)
            let rect = height > width
                ? CGRect(x: width * 0.018, y: height * 0.053, width: width * 0.964, height: height * 0.939).integral
                : CGRect(x: 0, y: 0, width: width, height: height)
            guard let cropped = full.cropping(to: rect) else { return }
            let bitmap = NSBitmapImageRep(cgImage: cropped)
            guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.70]),
                  jpeg.count < 2_000_000 else { return }
            var size = UInt32(jpeg.count).bigEndian
            withUnsafeBytes(of: &size) { output.write(Data($0)) }
            output.write(jpeg)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data(error.localizedDescription.utf8))
        exit(1)
    }
}

@main struct LiveStream {
    static func main() async {
        _ = NSApplication.shared
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = content.windows
                .filter({ $0.owningApplication?.bundleIdentifier == mirrorBundleID && $0.frame.width > 150 && $0.frame.height > 250 })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                throw NSError(domain: "LiveStream", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有找到 iPhone 镜像窗口"])
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = max(1, Int(window.frame.width * 2))
            config.height = max(1, Int(window.frame.height * 2))
            config.minimumFrameInterval = CMTime(value: 1, timescale: 20)
            config.queueDepth = 3
            config.showsCursor = false
            let output = FrameOutput()
            let stream = SCStream(filter: filter, configuration: config, delegate: output)
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "phone-workbench.live-frames"))
            try await stream.startCapture()
            while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(1)
        }
    }
}

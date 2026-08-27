import type { ModelMetadata, UserImage } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import { loadUserImageFile } from "@/utils";
import { readClipboardImage } from "../clipboard-image";
import type { Editor } from "../components";
import type { Tui } from "../runtime";
import type { TuiModelSettings } from "./model-selection";

export type ImageAttachmentControllerOptions = {
  editor: Editor;
  tui: Tui;
  getModelMetadata: () => ModelMetadata;
  getModelSettings?: () => TuiModelSettings;
  showError: (error: unknown) => void;
  getLogger?: () => Logger;
};

export class ImageAttachmentController {
  private clipboardReadActive = false;
  private fileAttachActive = false;

  constructor(private readonly options: ImageAttachmentControllerOptions) {}

  getInputError(images: readonly UserImage[]): Error | undefined {
    return images.length > 0 ? this.getAvailabilityError() : undefined;
  }

  async pasteClipboard(): Promise<void> {
    if (this.clipboardReadActive) {
      return;
    }

    this.clipboardReadActive = true;
    try {
      const image = await readClipboardImage();
      if (!image) {
        throw new Error("The clipboard does not contain an image.");
      }

      const availabilityError = this.getAvailabilityError();
      if (availabilityError) {
        throw availabilityError;
      }
      this.options.editor.attachImage(image);
      try {
        (this.options.getLogger ?? createNoopLogger)().debug("tui.clipboard_paste_completed", {
          contentType: "image",
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
        });
      } catch {
        // Clipboard diagnostics must not change attachment behavior.
      }
    } catch (error) {
      try {
        (this.options.getLogger ?? createNoopLogger)().warn("tui.clipboard_paste_failed", {
          platform: process.platform,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Clipboard diagnostics must not replace the user-facing failure.
      }
      this.options.showError(error);
    } finally {
      this.clipboardReadActive = false;
      this.options.tui.requestRender();
    }
  }

  async attachFile(path: string): Promise<void> {
    if (this.fileAttachActive) {
      return;
    }

    this.fileAttachActive = true;
    try {
      const availabilityError = this.getAvailabilityError();
      if (availabilityError) {
        throw availabilityError;
      }
      const image = await loadUserImageFile(path);
      this.options.editor.attachImage(image);
      this.options.editor.setText("");
      try {
        (this.options.getLogger ?? createNoopLogger)().debug("tui.image_file_attach_completed", {
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
        });
      } catch {
        // Image diagnostics must not change attachment behavior.
      }
    } catch (error) {
      try {
        (this.options.getLogger ?? createNoopLogger)().warn("tui.image_file_attach_failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Image diagnostics must not replace the user-facing failure.
      }
      this.options.showError(error);
    } finally {
      this.fileAttachActive = false;
      this.options.tui.requestRender();
    }
  }

  private getAvailabilityError(): Error | undefined {
    const metadata = this.options.getModelMetadata();
    if (metadata.supportsImageInput !== true) {
      return new Error(`Model ${metadata.model} does not support image input.`);
    }

    const settings = this.options.getModelSettings?.();
    if (!settings || settings.activeProvider !== metadata.provider) {
      return undefined;
    }
    const enabled = settings.model[settings.activeProvider].imageInputEnabled;
    return enabled ? undefined : new Error("Image input is disabled by the active Agent policy.");
  }
}

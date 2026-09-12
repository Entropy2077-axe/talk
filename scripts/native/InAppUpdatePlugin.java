package com.talk.aichat;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/** Downloads Talk's public GitHub Release APK and hands it to Android's package installer. */
@CapacitorPlugin(name = "InAppUpdate")
public class InAppUpdatePlugin extends Plugin {
  private final Handler handler = new Handler(Looper.getMainLooper());

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    String url = call.getString("url");
    String title = call.getString("title", "Talk update");
    Uri source;
    try {
      source = Uri.parse(url);
    } catch (RuntimeException error) {
      call.reject("更新下载地址无效", error);
      return;
    }
    if (url == null
        || !"https".equalsIgnoreCase(source.getScheme())
        || !"github.com".equalsIgnoreCase(source.getHost())
        || source.getPath() == null
        || !source.getPath().startsWith("/Entropy2077-axe/talk/releases/download/")) {
      call.reject("只允许从 Talk 的 GitHub Release 下载更新");
      return;
    }

    try {
      String filename = "talk-" + title.replaceAll("[^a-zA-Z0-9._-]+", "-") + ".apk";
      File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
      if (directory == null) throw new IllegalStateException("下载目录不可用");
      File updatesDirectory = new File(directory, "updates");
      if (!updatesDirectory.isDirectory() && !updatesDirectory.mkdirs()) throw new IllegalStateException("无法创建更新目录");
      File target = new File(updatesDirectory, filename);
      if (target.isFile() && !target.delete()) throw new IllegalStateException("无法替换旧的更新文件");

      DownloadManager.Request request = new DownloadManager.Request(source)
        .setTitle(title)
        .setDescription("正在下载 Talk 更新")
        .setMimeType("application/vnd.android.package-archive")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(false)
        .setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, "updates/" + filename);
      DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
      long downloadId = manager.enqueue(request);
      waitForDownload(call, manager, downloadId);
    } catch (RuntimeException error) {
      call.reject("无法开始下载更新", error);
    }
  }

  @PluginMethod
  public void installDownloaded(PluginCall call) {
    Long downloadId = call.getLong("downloadId");
    if (downloadId == null) {
      call.reject("缺少已下载的更新");
      return;
    }
    openInstaller(call, downloadId);
  }

  private void waitForDownload(PluginCall call, DownloadManager manager, long downloadId) {
    handler.postDelayed(new Runnable() {
      @Override
      public void run() {
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
          if (!cursor.moveToFirst()) {
            call.reject("更新下载任务已失效");
            return;
          }
          int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
          if (status == DownloadManager.STATUS_SUCCESSFUL) {
            openInstaller(call, downloadId);
          } else if (status == DownloadManager.STATUS_FAILED) {
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            call.reject("更新下载失败（" + reason + "）");
          } else {
            handler.postDelayed(this, 750);
          }
        } catch (RuntimeException error) {
          call.reject("无法读取更新下载状态", error);
        }
      }
    }, 500);
  }

  private void openInstaller(PluginCall call, long downloadId) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
      Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
      settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(settingsIntent);
      resolve(call, "permission-required", downloadId);
      return;
    }

    DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    Uri apkUri = manager.getUriForDownloadedFile(downloadId);
    if (apkUri == null) {
      call.reject("找不到已下载的 APK，请重新下载");
      return;
    }
    try {
      Intent installIntent = new Intent(Intent.ACTION_VIEW);
      installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
      installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getContext().startActivity(installIntent);
      resolve(call, "installer-opened", downloadId);
    } catch (RuntimeException error) {
      call.reject("无法打开 Android 安装程序", error);
    }
  }

  private void resolve(PluginCall call, String status, long downloadId) {
    JSObject result = new JSObject();
    result.put("status", status);
    result.put("downloadId", downloadId);
    call.resolve(result);
  }
}

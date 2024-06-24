const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");
const traverse = require("@babel/traverse").default;
const parser = require("@babel/parser");
const flatten = require("array-flatten");

const exts = [".jpg", ".png", "jpeg"];
const max = 5200000; // 5MB == 5242848.754299136
let rcsoutput = null;
let filesLength = 0;
let entries = [];
let DeepLoop = false; // 是否需要深度递归

const rootPath = vscode.workspace.rootPath;
// 求次幂
function pow1024(num) {
  return Math.pow(1024, num);
}

const filterSize = (size) => {
  if (!size) return "";
  if (size < pow1024(1)) return size + " B";
  if (size < pow1024(2)) return (size / pow1024(1)).toFixed(2) + " KB";
  if (size < pow1024(3)) return (size / pow1024(2)).toFixed(2) + " MB";
  if (size < pow1024(4)) return (size / pow1024(3)).toFixed(2) + " GB";
  return (size / pow1024(4)).toFixed(2) + " TB";
};

function toPercent(point) {
  var str = Number(point * 100).toFixed(2);
  str += "%";
  return str;
}

// 获取当前工作区间是否有local.env.js文件
const getLocalEnv = () => {
  try {
    let url = `${rootPath}/local.env.js`;
    var code = fs.readFileSync(url, "utf8");
    const ast = parser.parse(code, {
      sourceType: "module",
    });
    let filter = null;
    traverse(ast, {
      ObjectProperty: {
        enter: (path) => {
          if (path.node.key.name === "filter") {
            filter = path.node.value.value;
          }
        },
      },
    });
    if (filter) return filter;
    return "noLocalEnv";
  } catch (err) {
    return "noLocalEnv";
  }
};

const options = {
  method: "POST",
  hostname: "tinypng.com",
  path: "/backend/opt/shrink",
  headers: {
    rejectUnauthorized: false,
    "Postman-Token": Date.now(),
    "Cache-Control": "no-cache",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36",
  },
};

// 生成随机IP， 赋值给 X-Forwarded-For
function getRandomIP() {
  return Array.from(Array(4))
    .map(() => parseInt(Math.random() * 255))
    .join(".");
}

// 过滤文件格式，返回所有jpg,png图片
function fileFilter(file, index) {
  fs.stat(file, (err, stats) => {
    if (err) return vscode.window.showErrorMessage(err);
    if (
      // 必须是文件，小于5MB，后缀 jpg||png||jpeg
      stats.size <= max &&
      stats.isFile() &&
      exts.includes(path.extname(file))
    ) {
      // 通过 X-Forwarded-For 头部伪造客户端IP
      options.headers["X-Forwarded-For"] = getRandomIP();
      fileUpload(file, index);
    } else if (DeepLoop && stats.isDirectory()) {
      fileList(file);
    }
  });
}

// 异步API,压缩图片
function fileUpload(img, index) {
  let req = https.request(options, function (res) {
    res.on("data", (buf) => {
      let obj = JSON.parse(buf.toString());
      if (obj.error) {
        // 错误的信息打印在右下角弹窗内，30s内关闭
        const errInfo = `[${img}]：压缩失败！报错：${obj.message}`;
        consoleLogInfo(errInfo);
        vscode.window.showErrorMessage(errInfo);
      } else {
        fileUpdate(img, obj, index);
      }
    });
  });

  req.write(fs.readFileSync(img), "binary");
  req.on("error", (e) => {
    vscode.window.showErrorMessage(e);
  });
  req.end();
}

// 该方法被循环调用,请求图片数据
function fileUpdate(imgpath, obj, index) {
  let options = new URL(obj.output.url);
  let req = https.request(options, (res) => {
    let body = "";
    res.setEncoding("binary");
    res.on("data", function (data) {
      body += data;
    });

    res.on("end", function () {
      fs.writeFile(imgpath, body, "binary", (err) => {
        if (err) return vscode.window.showErrorMessage(err);
        // 将这个成功信息打印在终端内
        const info = `[${imgpath}] \n 压缩成功，原始大小:${filterSize(
          obj.input.size
        )}，压缩大小:${filterSize(obj.output.size)}，优化比例:${toPercent(
          1 - obj.output.ratio
        )}`;
        consoleLogInfo(info);
        if (index === filesLength - 1) {
          vscode.window.showInformationMessage("图片压缩完毕");
          DeepLoop = false;
        }
      });
    });
  });
  req.on("error", (e) => {
    vscode.window.showErrorMessage(e);
  });
  req.end();
}
function processFiles(files, folder, index = 0) {
  if (index >= files.length) {
    return;
  }

  const file = files[index];
  fileFilter(path.join(folder, file), index);

  setTimeout(() => {
    processFiles(files, folder, index + 1);
  }, 2000); // 10秒
}

// 获取文件列表
const fileList = (folder) => {
  fs.readdir(folder, (err, files) => {
    if (err) vscode.window.showErrorMessage(err);
    filesLength = files.length;
    // files.forEach((file, index) => {
    //   fileFilter(path.join(folder, file), index);
    // });
    processFiles(files, folder);
  });
};

const walkingTree = (files) => {
  return flatten(
    files.map((file) => {
      const stats = fs.statSync(file);
      if (stats.isFile()) {
        return file;
      } else if (stats.isDirectory()) {
        const subfiles = fs.readdirSync(file);
        return walkingTree(
          subfiles.map((subfile) => {
            return path.join(file, subfile);
          })
        );
      }
    })
  );
};

const filterEntry = (localEnv) => {
  let startfiles = [];
  entries.forEach((filesurl) => {
    if (filesurl.indexOf(localEnv) > -1) {
      startfiles.push(filesurl);
    }
  });
  entries = startfiles;
};

function activate(context) {
  let singleImage = vscode.commands.registerCommand(
    "vscode-tinypng.singleImageCompression",
    singleImageCompression
  );
  let fileImage = vscode.commands.registerCommand(
    "vscode-tinypng.fileImageCompression",
    fileImageCompression
  );

  let fileImageDeep = vscode.commands.registerCommand(
    "vscode-tinypng.fileImageDeepCompression",
    fileImageDeepCompression
  );
  let localDeep = vscode.commands.registerCommand(
    "vscode-tinypng.currentLocalCompression",
    currentLocalCompression
  );
  context.subscriptions.push(singleImage);
  context.subscriptions.push(fileImage);
  context.subscriptions.push(fileImageDeep);
  context.subscriptions.push(localDeep);
}

// 打印压缩图片的详细信息
const showConsoleInfo = () => {
  if (!rcsoutput) {
    rcsoutput = vscode.window.createOutputChannel("super-tinyPng");
  }
  rcsoutput.show();
};

const consoleLogInfo = (info) => {
  rcsoutput.appendLine(info);
};

// 右键单个图片压缩
const singleImageCompression = (file) => {
  showConsoleInfo();
  filesLength = 1;
  fileFilter(file.fsPath, 0);
};

// 文件夹内图片压缩
const fileImageCompression = (folder) => {
  showConsoleInfo();
  fileList(folder.fsPath);
};

// 深度压缩文件夹内图片压缩
const fileImageDeepCompression = (folder) => {
  showConsoleInfo();
  DeepLoop = true;
  fileList(folder.fsPath);
};

// local.env  filter内图片压缩
const currentLocalCompression = () => {
  // 没有local.env的时候提示
  const localEnv = getLocalEnv();
  const NolocalEnvFile = localEnv === "noLocalEnv";
  if (NolocalEnvFile) {
    const tip = `没有找到local.env.js内的filter的字段，\n
                请右键文件夹执行tinypng：fileImageCompression，\n
                或者右键图片执行tinypng：singleImageCompression`;
    vscode.window.showErrorMessage(tip);
    return;
  }
  entries = [];
  walkingTree([path.resolve(path.resolve(rootPath, "src"))]).map((file) => {
    if (file.match(/\.(html)$/)) {
      let entry =
        file.split(".")[0].split(path.sep).slice(0, -1).join(path.sep) +
        path.sep +
        "img";
      entries.push(entry);
    }
  });
  filterEntry(localEnv);
  let imgDir = fs.existsSync(entries[0]);
  if (!imgDir) {
    vscode.window.showErrorMessage(
      `没有找到${localEnv}目录下面的img文件夹，\n
      请右键文件夹执行tinypng：fileImageCompression，\n
      或者右键图片执行tinypng：singleImageCompression`
    );
    return;
  }

  showConsoleInfo();
  // 递归执行localEnv下img内所有的文件
  DeepLoop = true;
  fileList(entries[0]);
};

exports.activate = activate;

function deactivate() {}
module.exports = {
  activate,
  deactivate,
};

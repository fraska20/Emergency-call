const { Client, LocalAuth, Buttons, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const { phoneNumberUnFormatter } = require("./helpers/formatter");

const port = process.env.PORT || 8000;

require("./utils/db");
const Keywoard = require("./model/keyword");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);

// set the view engine to ejs
app.set("views", "./views");
app.set("view engine", "ejs");

app.use(express.static("public"));

// index page
app.get("/", function (req, res) {
  res.render("index");
});

app.get("/maps", function (req, res) {
  res.render("maps");
});

app.get("/routing", function (req, res) {
  res.render("routing");
});

const client = new Client({
  restartOnAuthFail: true,
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process", // <- this one doesn't works in Windows
      "--disable-gpu",
    ],
  },
  authStrategy: new LocalAuth(),
});

client.on("message", async (msg) => {
  // check keyword in database
  const key = await Keywoard.findOne({ keyword: msg.body });
  console.log(msg.body);

  if (msg.body == "!ping") {
    msg.reply("pong");
  } else if (key) {
    msg.reply(key.respon);
  } else if (msg.body == "!sos") {
    const media = MessageMedia.fromFilePath("./public/images/gambar1.png");
    let button = new Buttons(
      media,
      [
        {
          body: "Open Maps",
          url: "http://localhost:8000/maps?no=" + msg.from,
        },
      ],
      "Emergency Call",
      "by jipies"
    );

    client.sendMessage(msg.from, button);
  }

  // else if (msg.body == "!groups") {
  //   client.getChats().then((chats) => {
  //     const groups = chats.filter((chat) => chat.isGroup);

  //     if (groups.length == 0) {
  //       msg.reply("You have no group yet.");
  //     } else {
  //       let replyMsg = "*YOUR GROUPS*\n\n";
  //       groups.forEach((group, i) => {
  //         replyMsg += `ID: ${group.id._serialized}\nName: ${group.name}\n\n`;
  //       });
  //       replyMsg +=
  //         "_You can use the group id to send a message to the group._";
  //       msg.reply(replyMsg);
  //     }
  //   });
  // }
});

client.initialize();

// Socket IO
io.on("connection", function (socket) {
  socket.emit("message", "Connecting...");

  client.on("qr", (qr) => {
    console.log("QR RECEIVED", qr);
    qrcode.toDataURL(qr, (err, url) => {
      socket.emit("qr", url);
      socket.emit("message", "QR Code received, scan please!");
    });
  });

  client.on("ready", () => {
    socket.emit("ready", "Whatsapp is ready!");
    socket.emit("message", "Whatsapp is ready!");
  });

  client.on("authenticated", () => {
    socket.emit("authenticated", "Whatsapp is authenticated!");
    socket.emit("message", "Whatsapp is authenticated!");
    console.log("AUTHENTICATED");
  });

  client.on("auth_failure", function (session) {
    socket.emit("message", "Auth failure, restarting...");
  });

  client.on("disconnected", (reason) => {
    socket.emit("message", "Whatsapp is disconnected!");
    client.destroy();
    client.initialize();
  });
});

const checkRegisteredNumber = async function (number) {
  const isRegistered = await client.isRegisteredUser(number);
  return isRegistered;
};

// Send message
app.post(
  "/send-message",
  [body("number").notEmpty(), body("message").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req).formatWith(({ msg }) => {
      return msg;
    });

    if (!errors.isEmpty()) {
      return res.status(422).json({
        status: false,
        message: errors.mapped(),
      });
    }

    // const number = phoneNumberFormatter(req.body.number);
    const number = req.body.number;
    const message = req.body.message;

    const isRegisteredNumber = await checkRegisteredNumber(number);

    if (!isRegisteredNumber) {
      return res.status(422).json({
        status: false,
        message: "The number is not registered",
      });
    }

    client
      .sendMessage(number, message)
      .then((response) => {
        res.status(200).json({
          status: true,
          response: response,
        });
      })
      .catch((err) => {
        res.status(500).json({
          status: false,
          response: err,
        });
      });
  }
);

const findGroupByName = async function (name) {
  const group = await client.getChats().then((chats) => {
    return chats.find(
      (chat) => chat.isGroup && chat.name.toLowerCase() == name.toLowerCase()
    );
  });
  return group;
};

// Send message to group
// You can use chatID or group name, yea!
app.post(
  "/send-group-message",
  [
    body("id").custom((value, { req }) => {
      if (!value && !req.body.name) {
        throw new Error("Invalid value, you can use `id` or `name`");
      }
      return true;
    }),
    body("message").notEmpty(),
    body("maps").notEmpty(),
    body("number").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req).formatWith(({ msg }) => {
      return msg;
    });

    if (!errors.isEmpty()) {
      return res.status(422).json({
        status: false,
        message: errors.mapped(),
      });
    }

    let chatId = req.body.id;
    const groupName = req.body.name;
    const message = req.body.message;
    const maps = req.body.maps;
    const no = phoneNumberUnFormatter(req.body.number);

    let button = new Buttons(
      message,
      [
        {
          body: "Pick Up",
          url: maps,
        },
        { body: "Call", number: "+" + no },
      ],
      "Emergency Call",
      "by jipies"
    );

    // Find the group by name
    if (!chatId) {
      const group = await findGroupByName(groupName);
      if (!group) {
        return res.status(422).json({
          status: false,
          message: "No group found with name: " + groupName,
        });
      }
      chatId = group.id._serialized;
    }

    client
      .sendMessage(chatId, button)
      .then((response) => {
        res.status(200).json({
          status: true,
          response: response,
        });
      })
      .catch((err) => {
        res.status(500).json({
          status: false,
          response: err,
        });
      });
  }
);

server.listen(port, function () {
  console.log("App running on *: " + port);
});

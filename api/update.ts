import { VercelRequest, VercelResponse } from "@vercel/node";
import { request, gql } from "graphql-request";
//import Twitter from "twitter";
import { ethers } from "ethers";

const fetch = require("@vercel/fetch")();
const bad_actors = [
  //vires
  "0x525419ff5707190389bfb5c87c375d710f5fcb0e",
  "0xbac7744ada4ab1957cbaafef698b3c068beb4fe0",
  //Karolak
  "0xdb22609515433e664e28067c81704d8266098986",
  "0xD93e0A15511935889AeC76f79D54DFf0e27af82e",
  "0xeA6Eb2033dE0FbECe9445FAe407C596f3fFd81AE",
  "0x51D191950353BDF1D6361e9264a49BF93F6AbD4A",
  "0x13364c017b282FB033107b3c0cCbf762332AcEBa",
  "0x5D98F8d269C94B746A5c3C2946634dCfc75E5E60",
  "0x75fbf65A3DFE93545C9768f163E59a02Daf08D36",
  //trancoder.eth
  "0xdb22609515433e664e28067c81704d8266098986",
];

const joke_emojis = ["🖕🏾", "🤡", "💩", "🚽", "🤮",'🩸','🔪','🤬','🤥','🧌','🤷🏾‍♂️','🙈'];

const pricePerPixel = 0.0000000000000012; // (1200 wei)

// the # of pixels in a minute of 240p30fps, 360p30fps, 480p30fps, 720p30fps transcoded renditions.
// (width * height * framerate * seconds in a minute)
const pixelsPerMinute = 2995488000;

export const getTotalFeeDerivedMinutes = ({
  faceValue,
  faceValueUSD,
  pricePerPixel,
  pixelsPerMinute,
}): number => {
  let ethDaiRate = faceValue / faceValueUSD;
  let usdAveragePricePerPixel = pricePerPixel / ethDaiRate;
  let feeDerivedMinutes =
    faceValueUSD / usdAveragePricePerPixel / pixelsPerMinute || 0;
  return feeDerivedMinutes;
};

// const client = new Twitter({
//   consumer_key: process.env.TWITTER_CONSUMER_KEY,
//   consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
//   access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
//   access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
// });

// Create cached connection variable
let cachedDb = null;

// A function for connecting to MongoDB,
// taking a single parameter of the connection string
async function connectToDatabase(uri) {
  // If the database connection is cached,
  // use it instead of creating a new connection
  if (cachedDb) {
    return cachedDb;
  }

  const MongoClient = require("mongodb").MongoClient;
  const client = await MongoClient.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  const db = client.db("payoutBot");

  // Cache the database connection and return the connection
  cachedDb = db;
  return db;
}

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.headers.authorization !== `Bearer ${process.env.API_TOKEN}`) {
    res.status(403);
    res.json({
      errors: ["Unauthorized"],
    });
  }
  const uri = `${process.env.MONGO_DB_URL}`;
  const db = await connectToDatabase(uri);

  const { timestamp } = await db.collection("payouts").findOne();
  const query = gql`
    query WinningTickets($lastCheckTime: Int!) {
      winningTicketRedeemedEvents(
        where: { timestamp_gt: $lastCheckTime }
        first: 8
        orderDirection: asc
        orderBy: timestamp
      ) {
        timestamp
        faceValue
        faceValueUSD
        recipient {
          id
        }
        transaction {
          id
        }
      }
    }
  `;

  const variables = {
    lastCheckTime: timestamp,
  };

  const { winningTicketRedeemedEvents } = await request(
    `${process.env.LP_SUBGRAPH_URL}`,
    query,
    variables
  );
  // Update last event time
  if (winningTicketRedeemedEvents && winningTicketRedeemedEvents.length == 0) {
    res.status(200).send("None");
  } else {
    if (winningTicketRedeemedEvents[winningTicketRedeemedEvents.length-1].timestamp > timestamp) {
      await db
        .collection("payouts")
        .replaceOne(
          {},
          { timestamp: winningTicketRedeemedEvents[winningTicketRedeemedEvents.length-1].timestamp }
        );
    }

    // Notify once for each new winning ticket
    for (const newTicket of winningTicketRedeemedEvents) {
      const { twitterStatus, discordDescription, image } =
        await getMessageDataForEvent(newTicket);

      // await client.post("statuses/update", {
      //   status: twitterStatus,
      // });

      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        body: JSON.stringify({
          username: `Willy "LP" Wonky`,
          avatar_url:
            "https://cdn.discordapp.com/emojis/796874313248014376.gif?size=240&quality=lossless",
          embeds: [
            {
              color: 60296,
              title: "Golden Ticket Payout",
              description: discordDescription,
              timestamp: new Date(newTicket.timestamp * 1000).toISOString(),
              url: `https://arbiscan.io/tx/${newTicket.transaction.id}`,
              ...(image && {
                thumbnail: {
                  url: image,
                },
              }),
            },
          ],
        }),
        headers: { "Content-Type": "application/json" },
      });
    }

    res.status(200).send("Success");
  }
};

export type Recipient = {
  id: string;
};

export type Transaction = {
  id: string;
};

export type WinningTicketRedeemedEvent = {
  timestamp: number;
  faceValue: string;
  faceValueUSD: string;
  recipient: Recipient;
  transaction: Transaction;
};

export const getMessageDataForEvent = async (
  event: WinningTicketRedeemedEvent
): Promise<{
  twitterStatus: string;
  minutes: number;
  name: string;
  image: string;
  discordDescription: string;
}> => {
  let name = event.recipient.id.replace(event.recipient.id.slice(8, 36), "…");
  let image = null;

  try {
    const l1Provider = new ethers.providers.JsonRpcProvider(
      `${process.env.L1_RPC_URL}`
    );

    const ensName = await l1Provider.lookupAddress(event.recipient.id);

    if (ensName) {
      name = ensName;
    }

    const ensAvatar = await l1Provider.getAvatar(event.recipient.id);

    if (ensAvatar) {
      image = ensAvatar;
    }
  } catch (e) {
    // catch all to allow messages to always be sent
    console.error(e);
  }

  const minutes = await getTotalFeeDerivedMinutes({
    faceValue: event.faceValue,
    faceValueUSD: event.faceValueUSD,
    pricePerPixel,
    pixelsPerMinute,
  });

  const twitterStatus = `Livepeer orchestrator ${name} just earned ${parseFloat(
    event.faceValue
  ).toFixed(4)} ETH ($${parseFloat(event.faceValueUSD).toFixed(
    2
  )}) transcoding approximately ${Math.round(
    minutes
  ).toLocaleString()} minutes of video. https://arbiscan.io/tx/${
    event.transaction.id
  } `;

  let discordDescription = `[**${name}**](https://explorer.livepeer.org/accounts/${
    event.recipient.id
  }/campaign) just earned **${parseFloat(event.faceValue).toFixed(
    4
  )} ETH ($${parseFloat(event.faceValueUSD).toFixed(
    2
  )})** transcoding approximately ${Math.round(
    minutes
  ).toLocaleString()} minutes of video.`;

  if (bad_actors.includes(event.recipient.id))
    discordDescription =
      discordDescription + getNextJokeEmoji() + getNextJokeEmoji();

  return { twitterStatus, minutes, image, name, discordDescription };
};

const getNextJokeEmoji = () => {
  return joke_emojis[Math.floor(Math.random() * joke_emojis.length)];
};

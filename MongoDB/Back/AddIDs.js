const mongoose = require("mongoose");
const Oblast = require("./models/Oblast"); // promeni putanju ako je model negde drugde

mongoose.connect("mongodb://localhost:27017/tvojaBaza", {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

async function addTestIds() {
    const oblasti = await Oblast.find();
    for (let oblast of oblasti) {
        let changed = false;
        for (let test of oblast.testovi) {
            if (!test._id) {
                test._id = new mongoose.Types.ObjectId();
                changed = true;
            }
        }
        if (changed) {
            await oblast.save();
            console.log(`Dodati ID-evi za oblast: ${oblast.naziv}`);
        }
    }
    console.log("Gotovo!");
    mongoose.disconnect();
}

addTestIds().catch(console.error);

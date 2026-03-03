const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
app.use(cors());
app.use(express.json());


const jwt = require("jsonwebtoken");
const SECRET = "tajna_za_jwt";

//Povezivanje sa lokalnom MongoDB bazom
mongoose.connect("mongodb://127.0.0.1:27017/quizDB")
    .then(() => console.log("Povezano na lokalni MongoDB"))
    .catch(err => console.error("Greska pri povezivanju:", err));

//------------------ SCHEME ------------------ //

//KORISNIK
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["student", "profesor", "admin"], default: "student" }
});
const User = mongoose.model("User", userSchema);

//ODGOVORI
const answerSchema = new mongoose.Schema({
    tekst: { type: String, required: true },
    tacan: { type: Boolean, required: true }
});

//PITANJA
const questionSchema = new mongoose.Schema({
    _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
    tekst: { type: String, required: true },
    odgovori: [answerSchema]
});

//TESTOVI
const testSchema = new mongoose.Schema({
    _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
    naziv: { type: String, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    pitanja: [questionSchema],
    datumKreiranja: { type: Date, default: Date.now },
    opis: String
});

//OBLASTI
const oblastSchema = new mongoose.Schema({
    naziv: { type: String, required: true },
    testovi: [testSchema]
});
const Oblast = mongoose.model("Oblast", oblastSchema);

//REZULTATI
const resultSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    testId: { type: mongoose.Schema.Types.ObjectId, required: true },
    oblastId: { type: mongoose.Schema.Types.ObjectId, required: true },
    brojTacnih: { type: Number, required: true },
    ukupnoPitanja: { type: Number, required: true },
    procenat: { type: Number },
    datum: { type: Date, default: Date.now }
});

resultSchema.pre("save", async function () {
    this.procenat = Math.round((this.brojTacnih / this.ukupnoPitanja) * 100);
    //next();
});
const Result = mongoose.model("Result", resultSchema);


//------------------ ULOGE ------------------//
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: "No token" });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, SECRET); //PROVERAVA TOKEN
        req.user = {
            _id: decoded.userId,
            role: decoded.role
        };
        next();
    } catch (err) {
        console.error("JWT ERROR:", err.message);
        return res.status(403).json({ message: "Invalid token" });
    }
};

const allowRoles = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: "Nemate dozvolu" });
        }
        next();
    };
};

app.post("/api/login", async (req, res) => {

    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user)
            return res.status(401).json({ message: "Neispravno korisnicko ime ili lozinka" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch)
            return res.status(401).json({ message: "Neispravno korisnicko ime ili lozinka" });

        const token = jwt.sign(
            { userId: user._id, role: user.role },
            SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            token,
            user: {
                _id: user._id,
                username: user.username,
                role: user.role
            }
        });

    } catch (err) {
        res.status(500).json({ message: "Greška servera" });
    }

});

app.post("/api/register", async (req, res) => {

    try {
        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ message: "Sva polja su obavezna" });
        }

        const existingUser = await User.findOne({
            $or: [{ username }, { email }]
        });

        if (existingUser) {
            return res.status(400).json({
                message: "Korisničko ime ili email već postoji"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            role: role || "student" // sada prihvata poslatu rolu
        });

        await newUser.save();

        res.status(201).json({ message: "Uspešna registracija" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Greška servera" });
    }

});


//------------------ CRUD ------------------ //

//DODAVANJE OBLASTI ULOGE
app.post(
    "/api/oblasti",
    authMiddleware,
    allowRoles("admin"),
    async (req, res) => {
        const { naziv } = req.body;

        try {
            const novaOblast = new Oblast({ naziv, testovi: [] });
            await novaOblast.save();
            res.status(201).json(novaOblast);
        } catch (err) {
            res.status(500).json({ message: "Greska pri dodavanju oblasti" });
        }
    }
);

//BRISANJE OBLASTI
app.delete(
    "/api/oblasti/:oblastId",
    authMiddleware,
    allowRoles("admin"),
    async (req, res) => {
        const { oblastId } = req.params;

        try {
            const oblast = await Oblast.findById(oblastId);
            if (!oblast) {
                return res.status(404).json({ message: "Oblast nije pronađena" });
            }

            await Oblast.findByIdAndDelete(oblastId);

            return res.json({
                message: "Oblast i svi testovi u njoj su obrisani"
            });
        } catch (err) {
            console.error("Greška pri brisanju oblasti:", err);
            return res.status(500).json({
                message: "Greška servera pri brisanju oblasti"
            });
        }
    }
);

//DODAVANJE TESTA ULOGE
app.post(
    "/api/oblasti/:oblastId/testovi",
    authMiddleware,
    allowRoles("admin", "profesor"),
    async (req, res) => {
        const { oblastId } = req.params;
        const { naziv, opis } = req.body;

        try {
            const oblast = await Oblast.findById(oblastId);
            if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

            if (!req.user || !req.user._id) {
                return res.status(401).json({ message: "Autor nije validan" });
            }

            console.log("REQ.USER:", req.user);


            const noviTest = {
                naziv,
                opis,
                authorId: req.user._id, 
                pitanja: []
            };

            oblast.testovi.push(noviTest);
            await oblast.save();

            res.status(201).json({
                message: "Test uspesno kreiran",
                test: oblast.testovi[oblast.testovi.length - 1]
            });
        } catch (err) {
            res.status(500).json({ message: "Greska pri kreiranju testa" });
            console.error(err.response?.data || err);
            alert(err.response?.data?.message || "Dodavanje testa nije uspelo");
        }
    }
);

//BRISANJE TESTA
app.delete(
    "/api/oblasti/:oblastId/testovi/:testId",
    authMiddleware,
    allowRoles("admin", "profesor"),
    async (req, res) => {
        const { oblastId, testId } = req.params;

        try {
            const oblast = await Oblast.findById(oblastId);
            if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

            const test = oblast.testovi.id(testId);
            if (!test) return res.status(404).json({ message: "Test nije pronadjen" });

            if (req.user.role === "profesor" && test.authorId.toString() !== req.user._id.toString()) {
                return res.status(403).json({ message: "Nemate dozvolu da dodate pitanje u ovom testu" });
            }

            test.deleteOne();
            await oblast.save();

            res.json({ message: "Test obrisan" });
        } catch (err) {
            res.status(500).json({ message: "Greska pri brisanju testa" });
        }
    }
);


//DODAVANJE PITANJA
app.post("/api/oblasti/:oblastId/testovi/:testId/pitanja", authMiddleware, allowRoles("admin", "profesor"), async (req, res) => {
    try {
        const { oblastId, testId } = req.params;
        const { tekst, odgovori } = req.body;

        const oblast = await Oblast.findById(oblastId);
        if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

        const test = oblast.testovi.id(testId);
        if (!test) return res.status(404).json({ message: "Test nije pronadjen" });

        if (req.user.role === "profesor" && test.authorId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: "Nemate dozvolu da dodate pitanje u ovom testu" });
        }

        test.pitanja.push({ tekst, odgovori });
        await oblast.save();

        res.status(201).json({
            message: "Pitanje dodato",
            pitanje: test.pitanja[test.pitanja.length - 1]
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Dodavanje pitanja nije uspelo", error: err.message });
    }
});

//DODAVANJE REZULTATA
app.post("/api/testovi/:testId/rezultat", async (req, res) => {

    try {
        const { userId, oblastId, odgovoriKorisnika } = req.body;
        const { testId } = req.params;

        const oblast = await Oblast.findById(oblastId);
        if (!oblast) {
            return res.status(404).json({ message: "Oblast nije pronađena" });
        }

        const test = oblast.testovi.id(testId);
        if (!test) {
            return res.status(404).json({ message: "Test nije pronađen" });
        }

        let ukupnoPoena = 0;
        let maxPoena = test.pitanja.length;
        const rezultatPoPitanju = [];

        test.pitanja.forEach(pitanje => {
            const korisnicki = odgovoriKorisnika.find(
                o => o.pitanjeId === pitanje._id.toString()
            );

            const tacniOdgovori = pitanje.odgovori
                .filter(o => o.tacan)
                .map(o => o._id.toString());

            const korisnickiOdgovori = korisnicki?.odgovorIds || [];

            const pogodjeniTacni = korisnickiOdgovori.filter(id =>
                tacniOdgovori.includes(id)
            ).length;

            const pogresni = korisnickiOdgovori.filter(id =>
                !tacniOdgovori.includes(id)
            ).length;

            let poeniZaPitanje = 0;

            if (pogresni === 0 && tacniOdgovori.length > 0) {
                poeniZaPitanje = pogodjeniTacni / tacniOdgovori.length;
            }

            ukupnoPoena += poeniZaPitanje;

            rezultatPoPitanju.push({
                pitanjeId: pitanje._id,
                tacniOdgovori,
                korisnickiOdgovori,
                poeniZaPitanje
            });
        });

        let sacuvanRezultat = null;

        if (userId) {
            sacuvanRezultat = new Result({
                userId,
                testId,
                oblastId,
                brojTacnih: ukupnoPoena,
                ukupnoPitanja: maxPoena
            });

            await sacuvanRezultat.save();
        }

        return res.json({
            brojTacnih: ukupnoPoena,
            ukupnoPitanja: maxPoena,
            rezultatPoPitanju,
            sacuvan: !!sacuvanRezultat
        });

    } catch (err) {
        console.error("GRESKA PRI RACUNANJU REZULTATA:", err);
        return res.status(500).json({ message: "Greška pri obradi rezultata" });
    }

});

//VRACANJE KORISNIKA
app.get("/api/me/:userId", async (req, res) => {
    try {
        const user = await User.findById(req.params.userId, "username role");
        if (!user) return res.status(404).json({ message: "Korisnik nije pronadjen" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: "Greska prilikom dohvatanja korisnika" });
    }
});

//VRACANJE REZULTATA KORISNIKA
app.get("/api/rezultati/:userId", async (req, res) => {
    try {
        const rezultati = await Result.find({ userId: req.params.userId })
            .populate("testId", "naziv")
            .populate("oblastId", "naziv")
            .sort({ datum: -1 });

        res.json(rezultati);
    } catch (err) {
        res.status(500).json({ message: "Greska pri vracanju rezultata" });
    }
});

//VRACANJE TESTOVA ZA OBLAST
app.get("/api/oblasti/:oblastId/testovi", async (req, res) => {
    const { oblastId } = req.params;

    try {
        const oblast = await Oblast.findById(oblastId, "naziv testovi");
        if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

        const testovi = oblast.testovi.map(t => ({
            _id: t._id,
            naziv: t.naziv,
            opis: t.opis,
            datumKreiranja: t.datumKreiranja,
            brojPitanja: t.pitanja.length,
            authorId: t.authorId
        }));

        res.json({ oblastId: oblast._id, oblastNaziv: oblast.naziv, testovi });
    } catch (err) {
        res.status(500).json({ message: "Greska pri vracanju testova", error: err.message });
    }
});

//GET SVI TESTOVI AUTORA
app.get("/api/testovi/autor/:authorId", async (req, res) => {
    try {
        const { authorId } = req.params;
        const oblasti = await Oblast.find({ "testovi.authorId": authorId });

        const sviTestovi = [];
        oblasti.forEach(oblast => {
            oblast.testovi.forEach(test => {
                if (test.authorId.toString() === authorId) {
                    sviTestovi.push({ oblastId: oblast._id, oblastNaziv: oblast.naziv, test });
                }
            });
        });

        res.json(sviTestovi);
    } catch (err) {
        res.status(500).json({ message: "Greska pri vracanju testova", error: err.message });
    }
});

//VRACANJE PITANJA TESTA
app.get("/api/oblasti/:oblastId/testovi/:testId", async (req, res) => {

    const { oblastId, testId } = req.params;

    try {
        const oblast = await Oblast.findById(oblastId, "naziv testovi");
        if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

        const test = oblast.testovi.id(testId);
        if (!test) return res.status(404).json({ message: "Test nije pronadjen" });

        const pitanja = test.pitanja.map(p => ({
            _id: p._id,
            tekst: p.tekst,
            odgovori: p.odgovori.map(o => ({ _id: o._id, tekst: o.tekst }))
        }));

        res.json({
            oblastId: oblast._id,
            oblastNaziv: oblast.naziv,
            testId: test._id,
            testNaziv: test.naziv,
            pitanja,
            authorId: test.authorId ? test.authorId.toString() : null
        });
    } catch (err) {
        res.status(500).json({ message: "Greska pri vracanju pitanja", error: err.message });
    }
});

//IZMENA PITANJA
app.put("/api/oblasti/:oblastId/testovi/:testId/pitanja/:pitanjeId", async (req, res) => {
    const { oblastId, testId, pitanjeId } = req.params;
    const { tekst, odgovori } = req.body;

    try {
        const oblast = await Oblast.findById(oblastId);
        if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

        const test = oblast.testovi.id(testId);
        if (!test) return res.status(404).json({ message: "Test nije pronadjen" });

        const pitanje = test.pitanja.id(pitanjeId);
        if (!pitanje) return res.status(404).json({ message: "Pitanje nije pronadjeno" });

        pitanje.tekst = tekst ?? pitanje.tekst;
        pitanje.odgovori = odgovori ?? pitanje.odgovori;

        await oblast.save();
        res.json({ message: "Pitanje izmenjeno", pitanje });
    } catch (err) {
        res.status(500).json({ message: "Greska pri izmeni pitanja", error: err.message });
    }
});

//BRISANJE PITANJA
app.delete(
    "/api/oblasti/:oblastId/testovi/:testId/pitanja/:pitanjeId",
    authMiddleware,
    allowRoles("admin", "profesor"),
    async (req, res) => {
        const { oblastId, testId, pitanjeId } = req.params;

        try {
            const oblast = await Oblast.findById(oblastId);
            if (!oblast) return res.status(404).json({ message: "Oblast nije pronadjena" });

            const test = oblast.testovi.id(testId);
            if (!test) return res.status(404).json({ message: "Test nije pronadjen" });

            const pitanje = test.pitanja.id(pitanjeId);
            if (!pitanje) return res.status(404).json({ message: "Pitanje nije pronadjeno" });

            if (
                req.user.role === "profesor" &&
                test.authorId.toString() !== req.user._id.toString()
            ) {
                return res.status(403).json({ message: "Nemate dozvolu" });
            }

            pitanje.deleteOne();
            await oblast.save();

            return res.json({ message: "Pitanje obrisano" });
        } catch (err) {
            return res.status(500).json({
                message: "Greska pri brisanju pitanja",
                error: err.message
            });
        }
    }
);

app.get("/api/oblasti", async (req, res) => {
    try {
        const oblasti = await Oblast.find({}, "naziv _id");
        res.json(oblasti);
    } catch (err) {
        res.status(500).json({ message: "Greska pri vracanju oblasti", error: err.message });
    }
});

//------------------ POKRETANJE SERVERA ------------------ //
app.listen(5000, () => console.log("Server radi na http://localhost:5000"));


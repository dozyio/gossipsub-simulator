package config

type Config struct {
	// 12D3KooWD6d3jiuv2fuSDTBH2eWZN8aYYKzHTrquZF4dta1BYEgB
	Seed         string   `env:"SEED" envDefault:"0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd3"`
	Port         int      `env:"PORT" envDefault:"42069"`
	Topics       []string `env:"TOPICS"`
	DHTPrefix    string   `env:"DHTPREFIX" envDefault:"/local/lan"`
	DHTPublic    bool     `env:"DHTPUBLIC" envDefault:"false"`
	GossipD      int      `env:"GOSSIP_D" envDefault:"0"`
	GossipDlo    int      `env:"GOSSIP_DLO" envDefault:"0"`
	GossipDhi    int      `env:"GOSSIP_DHI" envDefault:"0"`
	GossipDout   int      `env:"GOSSIP_DOUT" envDefault:"0"`
	GossipDscore int      `env:"GOSSIP_DSCORE" envDefault:"0"`
	DisableNoise bool     `env:"DISABLE_NOISE" envDefault:"false"`
}
